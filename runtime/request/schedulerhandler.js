// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is responsible for scheduler job execution requests

var DataPipeline = require('./datapipeline'),
    Storage = require('../storage/storage'),
    core = require('../core'),
    StatusCodes = require('../statuscodes').StatusCodes;

exports = module.exports = SchedulerHandler;

var logSource = 'SchedulerHandler';

function SchedulerHandler(scriptManager, masterKey, appName, metrics) {
    this.scriptManager = scriptManager;
    this.masterKey = masterKey;
    this.appName = appName;
    this.metrics = metrics;
}

SchedulerHandler.prototype.handle = function (req, res) {
    var logger = req._context.logger,
        responseCallback = req._context.responseCallback,
        request = req._context.parsedRequest;

    request.job = req.params.job;

    logger.trace(logSource, 'Processing request');

    // only authorize execution if either the master key has 
    // been provided on the request, or if a valid token has
    // been provided
    if (!request.masterKey && !this._validateToken(request.authenticationToken, request.job)) {
        responseCallback(new core.MobileServiceError("Unauthorized"), null, StatusCodes.UNAUTHORIZED);
        return;
    }

    this.metrics.event('scheduler.execute');

    this.scriptManager.runSchedulerScript(request.job, logger);

    // after successfully invoking the script we return immediately.
    // the job will continue to run for as long as it needs.
    responseCallback(null, null, StatusCodes.OK);
};

SchedulerHandler.prototype._validateToken = function (token, jobName) {
    // scheduler auth tokens follow the principle of least access.
    // they grant permission for only a single app/job combo.
    if (!token ||
        token.claims.uid !== 'cron' ||
        token.claims["urn:microsoft:appid"] !== this.appName ||
        token.claims["urn:microsoft:scope"] !== jobName) {
        return false;
    }
    return true;
};