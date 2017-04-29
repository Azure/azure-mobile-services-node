// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is responsible for all communication with the remote logging service.
// It maintains a cache of log entries and flushes them in batches to the logging service
// at regular intervals.

var core = require('./core');

var http = require('http');
var url = require('url');
var util = require('util');
var events = require('events');
var _ = require('underscore');
var _str = require('underscore.string');

_.mixin(_str.exports());

exports = module.exports = LogWriter;

function LogWriter(flushTimeout, requestRetryMaxAttempts, requestRetryInterval, maxRequestSize, maxLogEntryFlushCount) {
    events.EventEmitter.call(this);

    this.flushTimeout = flushTimeout;
    this.requestRetryMaxAttempts = requestRetryMaxAttempts;
    this.requestRetryInterval = requestRetryInterval;
    this.maxRequestSize = maxRequestSize;
    this.maxLogEntryFlushCount = maxLogEntryFlushCount;
    
    this.flushQueued = false;
    this.userLogs = [];
    this.systemLogs = [];
    this.metrics = [];
}

util.inherits(LogWriter, events.EventEmitter);

LogWriter.prototype.initialize = function (logServiceURL, logServiceToken) {
    this.logServiceToken = logServiceToken;

    if (logServiceURL) {
        this.logServiceURL = url.parse(logServiceURL);

        // In version 0.6.18 of node, the url module returns the trailing ':' with the protocol. 
        // Adding a check for both https: and https to avoid breaking the logging service
        // if we upgrade to a newer version of node.
        if (this.logServiceURL.protocol.substring(0, 5) === 'https') {
            http = require('https');
        }
    }
};

LogWriter.prototype.writeUser = function (entry) {
    this.userLogs.push(entry);
    this.queueFlush();
};

LogWriter.prototype.writeSystem = function (entry) {
    delete entry.level;

    this.systemLogs.push(entry);

    if (entry.type === LogType.Error) {
        // if an error is logged, we want to flush immediately
        this.flush();
    }
    else {
        this.queueFlush();
    }
};

LogWriter.prototype.writeMetric = function (entry) {
    this.metrics.push(entry);
    this.queueFlush();
};

LogWriter.prototype.queueFlush = function () {
    // if there isn't currently a flush queued, queue one
    if (!this.flushQueued) {
        this.flushQueued = true;

        // "Debounce" log flush operations to reduce the load
        // on the logging service by batching multiple log entries
        // into a single request.
        var self = this;
        this.timer = setTimeout(() => {
            self.flush();
        }, this.flushTimeout);
    }
};

LogWriter.prototype.flush = function () {
    this.flushQueued = false;

    // flush system logs
    if (this.systemLogs.length > 0 && this._write) {
        this._enforceSystemLogBufferLimit();
        this._write('/logs', this.systemLogs);
    }
    this.systemLogs = [];

    // flush user logs
    if (this.userLogs.length > 0 && this._write) {
        this._enforceUserLogBufferLimit();
        this._write('/userlogs', this.userLogs);
    }
    this.userLogs = [];

    // flush metrics
    if (this.metrics.length > 0 && this._write) {
        this._write('/metrics', this.metrics);
    }
    this.metrics = [];
};

LogWriter.prototype.clear = function () {
    if (this.timer) {
        clearTimeout(this.timer);
    }
    this.systemLogs = [];
    this.userLogs = [];
    this.metrics = [];
    this.flushQueued = false;
};

// When we truncate system logs, we want to preserve the first and last entries,
// since they will contain the most useful information for diagnostics. 
// We truncate from the middle.
LogWriter.prototype._enforceSystemLogBufferLimit = function () {
    if (this.systemLogs.length > this.maxLogEntryFlushCount) {
        // fist, grab the first half of the logs
        var count = this.systemLogs.length;

        var logs = this.systemLogs.slice(0, this.maxLogEntryFlushCount / 2);

        // add a truncation entry to indicate logs were truncated
        var truncationEntry = logs.slice(-1)[0];
        truncationEntry.type = 'information';
        truncationEntry.summary = 'Log entries have been truncated because the log buffer limit was exceeded. Number of original log entries: ' + count;

        // add the last half, truncating the middle as necessary
        var remaining = this.systemLogs.slice(count - (this.maxLogEntryFlushCount / 2));
        logs = logs.concat(remaining);
        this.systemLogs = logs;
    }
};

LogWriter.prototype._enforceUserLogBufferLimit = function () {
    if (this.userLogs.length > this.maxLogEntryFlushCount) {
        this.userLogs = this.userLogs.slice(0, this.maxLogEntryFlushCount);
        var truncationEntry = this.userLogs.slice(-1)[0];
        truncationEntry.type = 'error';
        truncationEntry.message = 'Log entry buffer exceeded. Too many logs written in a short period of time.';
    }
};

// Default log writer. POSTS logs to the external log service.
LogWriter.prototype._write = function (path, logEntries) {
    if (!this.logServiceURL) {
        return;
    }

    var self = this;
    var retryCount = 0;

    // POST the log entries to the remote log service
    try {        
        // define a function to actually build and issue the POST request
        var postLogs = logEntries => {
            var logData = core.stringify(logEntries);
            var logSize = Buffer.byteLength(logData, 'utf8');

            // If we can't send all the log entries in one batch, split it into 
            // multiple batches, recursively if necessary.            
            if (logSize > self.maxRequestSize) {
                var batches = self._splitEntries(logEntries);
                batches.forEach(batch => {
                    postLogs(batch);
                });
                return;
            }

            var options = {
                host: self.logServiceURL.hostname,
                port: self.logServiceURL.port,
                path,
                method: 'POST',
                headers: {
                    'Host': self.logServiceURL.hostname,
                    'Content-Type': 'application/json',
                    'Content-Length': logSize,
                    'x-zumo-log-auth': self.logServiceToken
                }
            };

            function retryRequest(e) {
                // if the request failed, retry up to the maximum retry limit
                if (++retryCount <= self.requestRetryMaxAttempts) {
                    setTimeout(() => {
                        postLogs(logEntries);
                    }, self.requestRetryInterval);
                } else {
                    // if even after retries the request is still failing handle
                    // the error                    
                    handleLogServiceError(e);                    
                }
            }

            var req = self._createHttpRequest(options, res => {                
                if (res.statusCode >= 400) {
                    // Node's HTTP stack won't emit the error event for all error responses, so we need to handle errors here too.
                    var err = new Error("Error encountered communicating with the logging service, status code: " + res.statusCode);                    

                    if (res.statusCode < 500) {
                        // If we got a 4XX there is a bug somewhere and no point in retrying the request                                                
                        handleLogServiceError(err);
                    } else {
                        // If we got a 5XX proceed with the retry logic
                        retryRequest(err);
                    }
                }
            });
            
            req.on('error', retryRequest);
            req.write(logData);
            req.end();
        };

        postLogs(logEntries);
    }
    catch (e) {        
        handleLogServiceError(e);
    }

    function handleLogServiceError(e) {
        if (e) {
            e.writeToSystemLogs = path === '/userlogs'; // If something goes wrong trying to write to the user logs, we should attempt to capture that in the system logs.
        }
        self.emit('error', e);
    }
};

// factored as a method to facilitate testability/mocking
LogWriter.prototype._createHttpRequest = (options, callback) => http.request(options, res => {
    callback(res);
});

LogWriter.prototype._splitEntries = entries => {
    var batch1 = entries.slice(0, entries.length / 2);
    var batch2 = entries.slice(entries.length / 2);
    return [batch1, batch2];
};