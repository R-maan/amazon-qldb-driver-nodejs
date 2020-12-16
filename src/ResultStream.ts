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

import {
    ExecuteStatementResult,
    FetchPageResult,
    Page,
} from "aws-sdk/clients/qldbsession";
import { dom } from "ion-js";
import { Readable } from "stream";

import { Communicator } from "./Communicator";
import { Result } from "./Result";
import { IOUsage } from "./stats/IOUsage";
import { IOUsageImpl } from "./stats/IOUsageImpl";
import { TimingInformation } from "./stats/TimingInformation";
import { TimingInformationImpl } from "./stats/TimingInformationImpl";

/**
 * A class representing the result of a statement returned from QLDB as a stream.
 * Extends Readable from the Node.JS Stream API interface.
 * The stream will always operate in object mode.
 */
export class ResultStream extends Readable {
    private _communicator: Communicator;
    private _cachedPage: Page;
    private _txnId: string;
    private _shouldPushCachedPage: boolean;
    private _retrieveIndex: number;
    private _isPushingData: boolean;
    private _ioUsage: IOUsageImpl;
    private _timingInformation: TimingInformationImpl;

    /**
     * Create a ResultStream.
     * @param txnId The ID of the transaction the statement was executed in.
     * @param executeResult The returned result from the statement execution.
     * @param communicator The Communicator used for the statement execution.
     */
    constructor(txnId: string, executeResult: ExecuteStatementResult, communicator: Communicator) {
        super({ objectMode: true });
        this._communicator = communicator;
        this._cachedPage = executeResult.FirstPage;
        this._txnId = txnId;
        this._shouldPushCachedPage = true;
        this._retrieveIndex = 0;
        this._isPushingData = false;
        this._ioUsage = Result._getIOUsage(executeResult.ConsumedIOs);
        this._timingInformation = Result._getTimingInformation(executeResult.TimingInformation);
    }

    /**
     * Returns the number of read IO request for the executed statement.
     * @returns IOUsage, containing number of read IOs.
     */
    getConsumedIOs(): IOUsage {
        return this._ioUsage;
    }

    /**
     * Returns server-side processing time for the executed statement.
     * @returns TimingInformation, containing processing time.
     */
    getTimingInformation(): TimingInformation {
        return this._timingInformation;
    }

    /**
     * Implementation of the `readable.read` method for the Node Streams Readable Interface.
     * @param size The number of bytes to read asynchronously. This is currently not being used as only object mode is
     * supported.
     */
    _read(size?: number): void {
        if (this._isPushingData) {
            return;
        }
        this._isPushingData = true;
        this._pushPageValues();
    }

    /**
     * Pushes the values for the Node Streams Readable Interface. This method fetches the next page if is required and
     * handles converting the values returned from QLDB into an Ion value.
     * @returns Promise which fulfills with void.
     */
    private async _pushPageValues(): Promise<void> {
        let canPush: boolean = true;
        try {
            if (this._shouldPushCachedPage) {
                this._shouldPushCachedPage = false;
            } else if (this._cachedPage.NextPageToken) {
                try {
                    const fetchPageResult: FetchPageResult =
                        await this._communicator.fetchPage(this._txnId, this._cachedPage.NextPageToken);
                    this._cachedPage = fetchPageResult.Page;

                    if (this._ioUsage == null && fetchPageResult.ConsumedIOs != null) {
                        this._ioUsage = new IOUsageImpl(fetchPageResult.ConsumedIOs.ReadIOs)
                    } else if (this._ioUsage != null) {
                        this._ioUsage.accumulateIOUsage(fetchPageResult.ConsumedIOs);
                    }

                    if (this._timingInformation == null && fetchPageResult.TimingInformation != null) {
                        this._timingInformation =
                            new TimingInformationImpl(fetchPageResult.TimingInformation.ProcessingTimeMilliseconds)
                    } else if (this._timingInformation != null) {
                        this._timingInformation.accumulateTimingInfo(fetchPageResult.TimingInformation);
                    }

                    this._retrieveIndex = 0;
                } catch (e) {
                    this.destroy(e);
                    canPush = false;
                    return;
                }
            }

            while (this._retrieveIndex < this._cachedPage.Values.length) {
                const ionValue: dom.Value =
                    dom.load(Result._handleBlob(this._cachedPage.Values[this._retrieveIndex++].IonBinary));
                canPush = this.push(ionValue);
                if (!canPush) {
                    this._shouldPushCachedPage = this._retrieveIndex < this._cachedPage.Values.length;
                    return;
                }
            }

            if (!this._cachedPage.NextPageToken) {
                this.push(null);
                canPush = false;
            }

        } finally {
            this._isPushingData = false;

            if (canPush) {
                this._read();
            }
        }
    }
}
