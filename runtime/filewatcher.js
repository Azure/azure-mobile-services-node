// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// A simple filewatcher that monitors a single file for changes.

var core = require('./core');

var fs = require('fs');
var _ = require('underscore');
var _str = require('underscore.string');

_.mixin(_str.exports());

var logSource = 'FileWatcher';

function FileWatcher(filepath, logger, intervalMS, callback) {
    this.filepath = filepath;
    this.logger = logger;
    this.callback = callback;
    this.intervalMS = intervalMS;

    // for test mocking
    this.fs = fs;
}

FileWatcher.prototype.start = function () {
    this._createFileWatcher();
};

FileWatcher.prototype.stop = function () {
    if (this.interval) {
        clearInterval(this.interval);
    }
};

FileWatcher.prototype._createFileWatcher = function () {
    var self = this;

    this.logger.trace(logSource, _.sprintf("Starting filewatcher on file '%s'.", this.filepath));

    // get the initial timestamp
    this.fs.stat(this.filepath, (err, stats) => {
        if (!err) {
            self.lastModified = stats.mtime;
        }
        else {
            // if the initial file operation fails, its not a
            // big deal, we'll just wait for the next iteration
            // below to establish the initial timestamp
            self._logFileStatError(err);
        }

        // Start an interval to poll for changes. We need to use polling rather
        // than fs.watch, because for networked files polling is the only reliable
        // way of detecting changes (e.g. fs.watch file handles periodically become
        // invalid).
        self.interval = setInterval(() => {
            self.fs.stat(self.filepath, (err, stats) => {
                if (!err) {
                    // determine whether the file has changed since the last time we checked
                    if (self.lastModified && self.lastModified.getTime() < stats.mtime.getTime()) {
                        self.logger.trace(logSource, _.sprintf("File change detected for '%s'.", self.filepath));
                        self.lastModified = stats.mtime;
                        self.callback();
                    }
                    else {
                        self.lastModified = stats.mtime;
                    } 
                }
                else {
                    // Since we're dealing with a networked file system, we expect to get errors
                    // from time to time. We just log and ignore them
                    self._logFileStatError(err);
                }
            });
        }, self.intervalMS);
    });
};

FileWatcher.prototype._logFileStatError = function (err) {
    this.logger.trace(logSource, _.sprintf("Error retrieving file stats for '%s'.", this.filepath), err);
};

exports = module.exports = FileWatcher;