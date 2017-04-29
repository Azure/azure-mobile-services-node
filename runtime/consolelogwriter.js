// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is responsible for directing logging to the console. 
// Implements same public functions as logwriter.js.

var core = require('./core');

var util = require('util');
var events = require('events');

exports = module.exports = ConsoleLogWriter;

function ConsoleLogWriter() {
    events.EventEmitter.call(this);

    // Save console methods in order to avoid redirect logic
    this.consoleMethods = {
        info: console.info,
        warn: console.warn,
        error: console.error
    };
}

util.inherits(ConsoleLogWriter, events.EventEmitter);

ConsoleLogWriter.prototype._writeEntry = function (entry) {
    delete entry.level;

    var entryString = JSON.stringify(entry);

    // Apply the entry as an argument to the original console method within console scope
    switch (entry.type) {
        case 'error':
            this.consoleMethods.error.apply(console, [entryString]);
            break;
        case 'warning':
            this.consoleMethods.warn.apply(console, [entryString]);
            break;
        case 'information':
            this.consoleMethods.info.apply(console, [entryString]);
            break;
        default:
            this.consoleMethods.info.apply(console, [entryString]);
            break;
    }
};

function noop () {
    return;
}

ConsoleLogWriter.prototype.writeUser = ConsoleLogWriter.prototype._writeEntry;
ConsoleLogWriter.prototype.writeSystem = ConsoleLogWriter.prototype._writeEntry;
ConsoleLogWriter.prototype.initialize = noop;
ConsoleLogWriter.prototype.writeMetric = noop;
ConsoleLogWriter.prototype.queueFlush = noop;
ConsoleLogWriter.prototype.flush = noop;
ConsoleLogWriter.prototype.clear = noop;