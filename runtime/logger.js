// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------

var core = require('./core'),
    _ = require('underscore'),
    _str = require('underscore.string'),
    LogWriter = require('./logwriter'),
    ConsoleLogWriter = require('./consolelogwriter');

_.mixin(_str.exports());

exports = module.exports = Logger;

LogType = {
    Information: "information",
    Warning: "warning",
    Error: "error"
};

LogLevel = {
    Verbose: 0,
    Information: 1,
    Warning: 2,
    Error: 3,
    Off: 4
};

Logger.defaultFlushTimeout = 1000;
Logger.defaultRequestRetryMaxAttempts = 3;
Logger.defaultRequestRetryInterval = 500;
Logger.defaultRequestMaxSizeBytes = 49152; // This is the default value for uploadReadAheadSize which by default sets the upper bound for the request size the logging service will accept (http://www.iis.net/configreference/system.webserver/serverruntime)
Logger.defaultMaxLogEntryFlushCount = 1000;  // the maximum number of log entries that we'll flush

// Set the globally shared LogWriter, responsible for
// process-wide log aggregation and request batching to
// the external logging service
Logger.writer = new LogWriter(Logger.defaultFlushTimeout, Logger.defaultRequestRetryMaxAttempts, Logger.defaultRequestRetryInterval, Logger.defaultRequestMaxSizeBytes, Logger.defaultMaxLogEntryFlushCount);

function Logger(logLevel) {
    // user log settings
    this.maxUserLogMessageLength = 10000;

    // system log settings
    this.bufferedRequestLogEntries = [];
    this.level = (logLevel !== null) ? logLevel : LogLevel.Error;

    this.logWriter = Logger.writer;
}

// Called to start a request sequence. All current
// log entries will be cleared, and the specified requestID will
// be applied to all subsequent log calls.
Logger.prototype.startRequest = function (requestID) {
    this.bufferedRequestLogEntries = [];
    this.requestEntriesWritten = false;
    this.lastTimestamp = null;
    this.requestID = requestID;
};

// write an entry to the system log
Logger.prototype.log = function (level, type, source, summary, details, immediate) {
    var self = this;

    if (core.classof(details) !== 'string') {
        details = core.stringify(details);
    }

    var entry = this._createSystemLogEntry(level, type, source, summary, details);

    if (entry.type === LogType.Error) {
        // if an error is logged, we need to write
        // all entries regardless of log level
        // we do this to to dump as much information as possible to the logs
        // in unhandled exception scenarios        
        this.bufferedRequestLogEntries.forEach(function (entry) {
            self.logWriter.writeSystem(entry);
        });
        this.bufferedRequestLogEntries = [];
    }

    if (entry.level >= this.level) {
        // record the fact that one or more entries for the 
        // current request will be written
        this.requestEntriesWritten = true;
        this.logWriter.writeSystem(entry);
    }
    else {
        // capture any log entries we have skipped,
        // since if an error occurs, we'll still need
        // to log them
        this.bufferedRequestLogEntries.push(entry);
    }
};

// write an information level entry to the system log
Logger.prototype.trace = function (source, summary, details) {
    this.log(LogLevel.Verbose, LogType.Information, source, summary, details);
};

// write a warning level entry to the system log
Logger.prototype.warn = function (source, summary, details) {
    this.log(LogLevel.Warning, LogType.Warning, source, summary, details);
};

// log the specified error to the system log
Logger.prototype.error = function (source, err) {
    if (err && !err.loggedToSystem) {
        this.log(LogLevel.Error, LogType.Error, source, err.toString(), err.stack, true);
        err.loggedToSystem = true;
    }
};

// Log the specified user message to user log persistent storage.
// source: the script file that is causing this log entry to be written
// type: the LogType to log the message as
// message: can either be a string, error, or an object to json serialize
Logger.prototype.logUser = function (source, type, message) {
    if (message && message.loggedToUser) {
        return;
    }

    var messageToLog = message;
    if (core.isError(message)) {
        messageToLog = message.toString();
    }
    else if (message instanceof core.MobileServiceError)
    {
        messageToLog = message.message;
    }
    else if (core.classof(message) !== 'string') {
        messageToLog = core.stringify(message);
    }

    // note that this flag will not work if message
    // is a string literal
    message.loggedToUser = true;

    var entry = this._createUserLogEntry(source, type, messageToLog);

    this.logWriter.writeUser(entry);
};

Logger.prototype.logUserUnhandled = function (err) {
    var userScriptSource = core.parseUserScriptError(err);
    var stackPrefix = userScriptSource ? '' : 'An unhandled exception occurred. ';
    var stack = err.stack ? stackPrefix + err.stack : '';

    var errMsg = stack || err.message || err.toString();
    this.logUser(userScriptSource, 'error', errMsg);

    // If verbose logging is enabled, log this user error to system log as well.
    if (this.level === LogLevel.Verbose) {        
        this.trace('global', 'Unhandled user error: ' + err.message, stack);
    }
};

Logger.prototype.logMetrics = function (metrics) {
    var self = this;

    metrics.forEach(function (metric) {
        self.logWriter.writeMetric(metric);
    });
};

Logger.prototype._createSystemLogEntry = function (level, type, source, summary, details) {
    return createSystemLogEntry(this.requestID, this._getTimestamp(), level, type, source, summary, details);
};

function createSystemLogEntry(requestID, timestamp, level, type, source, summary, details) {
    // note: we use activityID/timeCreated as property
    // names because that's the event format the log
    // service expects
    var entry = {
        activityID: requestID,
        timeCreated: timestamp,
        level: level,
        type: type,
        source: source,
        summary: summary,
        details: details
    };

    return entry;
}

Logger.prototype._createUserLogEntry = function createUserLogEntry(source, type, message) {
    source = source || '';

    if (!(type == LogType.Information || type == LogType.Warning || type == LogType.Error)) {
        throw new Error('type must be Information, Warning or Error');
    }

    if (message && message.length > this.maxUserLogMessageLength) {
        // if the message length exceeds the max, truncate it
        message = message.substring(0, this.maxUserLogMessageLength - 16);
        message = message + ' [log truncated]';
    }

    var entry = {
        timeCreated: this._getTimestamp(),
        type: type,
        source: source,
        message: message
    };

    return entry;
};

Logger.prototype._getTimestamp = function () {
    var timestamp = new Date();

    if (this.lastTimestamp) {
        var lastTimestampValue = this.lastTimestamp.valueOf();
        if (timestamp.valueOf() <= lastTimestampValue) {
            // Due to resolution issues with JS Date, it is possible for two back
            // to back operations to receive the same timestamp value. In this case,
            // we add a millisecond ourselves to ensure log entries can be ordered
            // properly by timestamp
            timestamp = new Date(lastTimestampValue + 1);
        }
    }
    this.lastTimestamp = timestamp;

    return timestamp;
};

Logger.prototype.clear = function () {
    this.bufferedRequestLogEntries = [];
};

// performs global initialization of the Logger
Logger.initialize = function (logServiceURL, logServiceToken, isLoggingServiceDisabled) {
    if (isLoggingServiceDisabled) {
        Logger.writer = new ConsoleLogWriter();
    } else {
        Logger.writer.initialize(logServiceURL, logServiceToken);
    }
};

// force an immediate flush of all cached log entries
// not yet written
Logger.flush = function () {
    Logger.writer.flush();
};

// clear all cached log entries
Logger.clear = function () {
    Logger.writer.clear();
};