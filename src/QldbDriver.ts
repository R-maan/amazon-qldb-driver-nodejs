/*
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance with
 * the License. A copy of the License is located at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * or in the "license" file accompanying this file. This file is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
 * CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions
 * and limitations under the License.
 */

import { QLDBSession } from "aws-sdk";
import { ClientConfiguration } from "aws-sdk/clients/qldbsession";
import { globalAgent } from "http";
import { dom } from "ion-js";
import Semaphore from "semaphore-async-await";

import { version } from "../package.json";
import { Communicator } from "./Communicator";
import { 
    DriverClosedError, 
    isInvalidSessionException,
    SessionPoolEmptyError,
    StartTransactionError
 } from "./errors/Errors";
import { debug } from "./LogUtil";
import { defaultRetryPolicy } from "./retry/DefaultRetryPolicy";
import { QldbSession } from "./QldbSession";
import { Result } from "./Result";
import { RetryPolicy } from "./retry/RetryPolicy";
import { TransactionExecutor } from "./TransactionExecutor";
import { TransactionExecutionContext } from "./TransactionExecutionContext";

/**
  * This is the entry point for all interactions with Amazon QLDB.
  *
  * In order to start using the driver, you need to instantiate it with a ledger name:
  *
  * ```
  * let qldbDriver: QldbDriver = new QldbDriver(your-ledger-name);
  * ```
  * You can pass more parameters to the constructor of the driver which allow you to control certain limits
  * to improve the performance. Check the {@link QldbDriver.constructor} to see all the available parameters.
  *
  * A single instance of the QldbDriver is attached to only one ledger. All transactions will be executed against
  * the ledger specified.
  *
  * The driver exposes {@link QldbDriver.executeLambda}  method which should be used to execute the transactions.
  * Check the {@link QldbDriver.executeLambda} method for more details on how to execute the Transaction.
 */
export class QldbDriver {
    private _maxConcurrentTransactions: number;
    private _timeoutMillis: number;
    private _availablePermits: number;
    private _sessionPool: QldbSession[];
    private _semaphore: Semaphore;
    protected _qldbClient: QLDBSession;
    protected _ledgerName: string;
    protected _isClosed: boolean;
    protected _retryPolicy: RetryPolicy;

    /**
     * Creates a QldbDriver instance that can be used to execute transactions against Amazon QLDB. A single instance of the QldbDriver
     * is always attached to one ledger, as specified in the ledgerName parameter.
     *
     * @param ledgerName The name of the ledger you want to connect to. This is a mandatory parameter.
     * @param qldbClientOptions The object containing options for configuring the low level client.
     *                          See {@link https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/QLDBSession.html#constructor-details|Low Level Client Constructor}.
     * @param retryLimit When there is a failure while executing the transaction like OCC or any other retriable failure, the driver will try running your transaction block again.
     *                   This parameter tells the driver how many times to retry when there are failures. The value must be greater than 0. The default value is 4.
     *                   See {@link https://docs.aws.amazon.com/qldb/latest/developerguide/driver.best-practices.html#driver.best-practices.configuring} for more details.
     * @param maxConcurrentTransactions The driver internally uses a pool of sessions to execute the transactions. The maxConcurrentTransactions parameter
     *                  specifies the number of sessions that the driver can hold in the pool. The default is set to maximum number of sockets specified in the globalAgent.
     *                  See {@link https://docs.aws.amazon.com/qldb/latest/developerguide/driver.best-practices.html#driver.best-practices.configuring} for more details.
     * @param timeoutMillis The number of ms the driver should wait for a session to be available in the pool before giving up. The default value is 30000.
     * @throws RangeError if `retryLimit` is less than 0.
     */
    constructor(
        ledgerName: string,
        qldbClientOptions: ClientConfiguration = {},
        maxConcurrentTransactions: number = 0,
        retryPolicy: RetryPolicy = defaultRetryPolicy
    ) {
        qldbClientOptions.customUserAgent = `QLDB Driver for Node.js v${version}`;
        qldbClientOptions.maxRetries = 0;

        this._qldbClient = new QLDBSession(qldbClientOptions);
        this._ledgerName = ledgerName;
        this._isClosed = false;
        this._retryPolicy = retryPolicy;

        if (maxConcurrentTransactions < 0) {
            throw new RangeError("Value for poolLimit cannot be negative.");
        }

        let maxSockets: number;
        if (qldbClientOptions.httpOptions && qldbClientOptions.httpOptions.agent) {
            maxSockets = qldbClientOptions.httpOptions.agent.maxSockets;
        } else {
            maxSockets = globalAgent.maxSockets;
        }

        if (0 === maxConcurrentTransactions) {
            this._maxConcurrentTransactions = maxSockets;
        } else {
            this._maxConcurrentTransactions = maxConcurrentTransactions;
        }
        if (this._maxConcurrentTransactions > maxSockets) {
            throw new RangeError(
                `The session pool limit given, ${this._maxConcurrentTransactions}, exceeds the limit set by the client,
                 ${maxSockets}. Please lower the limit and retry.`
            );
        }

        this._availablePermits = this._maxConcurrentTransactions;
        this._sessionPool = [];
        this._semaphore = new Semaphore(this._maxConcurrentTransactions);
    }


    /**
     * This is the primary method to execute a transaction against Amazon QLDB ledger.
     *
     * When this method is invoked, the driver will acquire a `Transaction` and hand it to the `TransactionExecutor` you
     * passed via the `transactionFunction` parameter. Once the `transactionFunction`'s execution is done, the driver will try to
     * commit the transaction.
     * If there is a failure along the way, the driver will retry the entire transaction block. This would mean that your code inside the
     * `transactionFunction` function should be idempotent.
     *
     * You can also return the results from the `transactionFunction`. Here is an example code of executing a transaction
     *
     * ```
     * let result = driver.executeLambda(async (txn:TransactionExecutor) => {
     *   let a = await txn.execute("SELECT a from Table1");
     *   let b = await txn.execute("SELECT b from Table2");
     *   return {a: a, b: b};
     * });
     *```
     *
     * Please keep in mind that the entire transaction will be committed once all the code inside the `transactionFunction` is executed.
     * So for the above example the values inside the  transactionFunction, a and b, are speculative values. If the commit of the transaction fails,
     * the entire `transactionFunction` will be retried.
     *
     * The function passed via retryIndicator parameter is invoked whenever there is a failure and the driver is about to retry the transaction.
     * The retryIndicator will be called with the current attempt number.
     *
     * @param transactionFunction The function representing a transaction to be executed. Please see the method docs to understand the usage of this parameter.
     * @param retryIndicator An Optional function which will be invoked when the `transactionFunction` is about to be retried due to a failure.
     * TODO: Add exceptions which can be returned
     */
    async executeLambda(
        transactionLambda: (transactionExecutor: TransactionExecutor) => any,
        retryPolicy?: RetryPolicy
    ): Promise<any> {
        let session: QldbSession = null;
        retryPolicy = (retryPolicy == null) ? this._retryPolicy : retryPolicy;
        const transactionExecutionContext: TransactionExecutionContext = new TransactionExecutionContext();
        while(true) {
            try  {
                session = await this.getSession();
                return await session.executeLambda(transactionLambda, retryPolicy, transactionExecutionContext);
            } catch(err) {
                if (err instanceof StartTransactionError || isInvalidSessionException(err)) {
                    continue;
                }
                throw err;
            } finally {
                if (session != null) {
                    //CFR: In the follow-up CR when we change the pooleing
                    this._returnSessionToPool(session);
                }
            }
        }
    }

    /**
     * A helper method to get all the table names in a ledger.
     * @returns Promise which fulfills with an array of table names.
     */
    async getTableNames(): Promise<string[]> {
        const statement: string = "SELECT name FROM information_schema.user_tables WHERE status = 'ACTIVE'";
        return await this.executeLambda(async (transactionExecutor: TransactionExecutor) : Promise<string[]> => {
            const result: Result = await transactionExecutor.execute(statement);
            const resultStructs: dom.Value[] = result.getResultList();
            const listOfTableNames: string[] = resultStructs.map(tableNameStruct =>
                tableNameStruct.get("name").stringValue());
            return listOfTableNames;
        });
    }

    /**
     * This is a driver shutdown method which closes all the sessions and marks the driver as closed.
     * Once the driver is closed, no transactions can be executed on that driver instance.
     *
     * Note: There is no corresponding `open` method and the only option is to instantiate another driver.
     */
    close(): void {
        this._sessionPool.forEach(session => {
            session.endSession();
        });
        this._isClosed = true;
    }

    private async getSession(): Promise<QldbSession> {
        this._throwIfClosed();
        debug(
            `Getting session. Current free session count: ${this._sessionPool.length}. ` +
            `Currently available permit count: ${this._availablePermits}.`
        );
        const isPermitAcquired: boolean = this._semaphore.tryAcquire();
        if (isPermitAcquired) {
            this._availablePermits--;
            try {
                let session: QldbSession = this._sessionPool.pop();
                if (session == undefined) {
                    debug("Creating new pooled session.");
                    session = <QldbSession> (await this._createSession());
                }
                return session;
            } catch (e) {
                this._semaphore.release();
                this._availablePermits++;
                throw e;
            }
        }
        throw new SessionPoolEmptyError(this._timeoutMillis)
    }

    private _returnSessionToPool = (session: QldbSession): void => {
        if (session.isSessionOpen()) {
            this._sessionPool.push(session);
        }
        this._semaphore.release();
        this._availablePermits++;
        debug(`Session returned to pool; size is now ${this._sessionPool.length}.`);
    };

    private _throwIfClosed(): void {
        if (this._isClosed) {
            throw new DriverClosedError();
        }
    }

    private async _createSession(): Promise<QldbSession> {
        this._throwIfClosed();
        debug("Creating a new session.");
        const communicator: Communicator = await Communicator.create(this._qldbClient, this._ledgerName);
        return new QldbSession(communicator);
    }
}
