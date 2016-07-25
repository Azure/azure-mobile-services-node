// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// Provides helper functions for interacting with the file system

var fs = require('fs'),
    _ = require('underscore'),
    _str = require('underscore.string');

_.mixin(_str.exports());

exports = module.exports;

// allows us to mock fs for testing
exports.fs = fs;
exports.require = require;

var retriableFileErrorCodes = ['EBUSY'];

exports.removeExtension = function (fileName) {
    if (fileName) {
        var idx = fileName.lastIndexOf('.');
        if (idx > 0) {
            return fileName.slice(0, idx);
        }
    }
    return fileName;
};

// read a file asyncronously using the specified retry policy
// maxRetries and retryInterval are optional
exports.readFileWithRetries = function (filePath, logger, callback, maxRetries, retryInterval) {
    var self = this,
        retryCount = 0;

    maxRetries = maxRetries || 3;
    retryInterval = retryInterval || 500;

    function readFileWithRetries() {
        self.fs.readFile(filePath, 'utf8', function (err, data) {
            if (err) {
                // if the error is retriable, try again, up to the max retry count
                if (retriableFileErrorCodes.indexOf(err.code) !== -1 && retryCount++ < maxRetries) {
                    logger.log(LogLevel.Warning, LogType.Warning, 'FileLoader',
                        _.sprintf("File read failed with temporary error '%s'. Retrying.", err.code));

                    // retry only after some time has elapsed
                    _.delay(readFileWithRetries, retryInterval);
                }
                else {                    
                    callback(err, null);
                }
            }
            else {
                callback(null, data);
            }
        });
    }

    readFileWithRetries();
};

// read a node module using the specified retry policy
// maxRetries and retryInterval are optional
exports.requireWithRetries = function (filePath, logger, callback, maxRetries, retryInterval) {
    var self = this,
        retryCount = 0,
        loadedModule;

    maxRetries = maxRetries || 3;
    retryInterval = retryInterval || 500;

    function requireWithRetries() {
        try {
            loadedModule = self.require(filePath);
            callback(null, loadedModule);
        }
        catch (err) {
            // if the error is retriable, try again, up to the max retry count
            var isRetriableError = retriableFileErrorCodes.indexOf(err.code) !== -1;
            if (isRetriableError) {
                if (retryCount++ < maxRetries) {
                    logger.log(LogLevel.Warning, LogType.Warning, 'FileLoader',
                        _.sprintf("Module load failed with temporary error '%s'. Retrying.", err.code));
                   
                    // retry only after some time has elapsed
                    _.delay(requireWithRetries, retryInterval);
                }
                else {
                    callback(err, null);
                }
            }
            else {
                // unable to load the module - might be due to a syntax error, etc.
                callback(err, null);
            }
        }
    }

    requireWithRetries();
};

