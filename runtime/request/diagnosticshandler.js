// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is for handling requests to http://myapp.azure-mobile.net/diagnostics
// which is used by the availability monitoring feature. This endpoint is secured -
// it requires the master key header.

var StatusCodes = require('../statuscodes').StatusCodes,
    _ = require('underscore'),
    _str = require('underscore.string');

_.mixin(_str.exports());

exports = module.exports = DiagnosticsHandler;

var logSource = 'DiagnosticsHandler';

function DiagnosticsHandler(appName, version, storage) {
    this.appName = appName;
    this.version = version;
    this.storage = storage;
}

DiagnosticsHandler.prototype.handle = function (req, res) {
    var logger = req._context.logger,
        responseCallback = req._context.responseCallback,
        status = StatusCodes.OK;

    logger.trace(logSource, 'Processing request');

    var body = {
        service: {
            description: 'Windows Azure Mobile Services Node.js',
            status: {
                runtimeVersion: this.version,
                serviceName: this.appName,
                uptime: getServiceUptime(process.uptime())
            }
        }
    };

    this._getSqlStatus(req, function (err, sqlStatus) {
        if (err) {
            // indicate degraded service via the top level status code
            status = StatusCodes.SERVICE_UNAVAILABLE;
        }
        
        if (sqlStatus) {
            body['tables.sql'] = {
                description: 'Windows Azure Mobile Services SQL Azure Tables',
                status: sqlStatus
            };
        }

        responseCallback(null, body, status);
    });
};

DiagnosticsHandler.prototype._getSqlStatus = function (req, callback) {
    var logger = req._context.logger,
        sqlStatus = {
            statusCode: StatusCodes.OK,
            latencyMS: 0
        },
        startTime = new Date(),
        options = {
            disableUserLog: true
        };

    logger.trace(logSource, 'Checking SQL connectivity');

    this.storage.executeSql('SELECT', "SELECT getutcdate() AS currentDate", null, logger, options, function (err) {
        if (err) {
            sqlStatus.statusCode = StatusCodes.SERVICE_UNAVAILABLE;
            var errDetails = [];
            if (err.sqlstate) {
                errDetails.push('State: ' + err.sqlstate);
            }
            if (err.code) {
                errDetails.push('Number: ' + err.code);
            }
            if (errDetails.length === 0) {
                errDetails.push('Unknown');
            }
            sqlStatus.error = errDetails.join(', ');
        }

        sqlStatus.latencyMS = new Date() - startTime;

        callback(err, sqlStatus);
    });
};

function getServiceUptime (seconds) {
    // parse the time span components from the
    // total number of seconds
    var days = Math.floor(seconds / (60 * 60 * 24));
    seconds -= (days * 60 * 60 * 24);
    var hours = Math.floor(seconds / (60 * 60));
    seconds -= (hours * 60 * 60);
    var minutes = Math.floor(seconds / 60);
    seconds -= (minutes * 60);

    return _.sprintf('%02d.%02d:%02d:%02d', days, hours, minutes, seconds);
}
DiagnosticsHandler.getServiceUptime = getServiceUptime;
