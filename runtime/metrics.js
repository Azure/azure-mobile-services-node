// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module helps collects QoS and SQM metrics in the runtime. It's capable
// of capturing both timed latency events as well as counting the occurances of a
// specific event (SQL Error count, logged in user count, etc.). This module piggybacks
// on the global logger and uses the same mechanism to talk to the
// LoggingService as the system and user logs. However, unlike the other types
// of logs, all metrics are flushed to the LoggingService on a timer.

var core = require('./core');

exports = module.exports = Metrics;

var logSource = 'Metrics';

function Metrics(logger, sampleTimeout) {
    var self = this;
    this.logger = logger;

    this.installations = new InstallationsProcessor(logger);

    // Reset and prepare the metrics object
    this.reset();

    // Aggregate and send the logs every sampleTimeout ms
    if (sampleTimeout) {
        setInterval(() => {
            self.flush();
        }, sampleTimeout);
    }
}

Metrics.prototype.reset = function() {
    // Holds pre-aggregated events before they are written to the logging service
    this.events = {};
};

Metrics.prototype.startEvent = name => {
    name = name.toLowerCase();
    var now = new Date();
    return {
        name,
        startTime: now.getTime()
    };
};

Metrics.prototype.endEvent = function (event) {  
    // If the value is null or undefined then bail
    if (!event) {
        return;
    }

    var now = new Date();

    // Construct intermediate event which will later be aggregated
    var latencyEvent = {
        name: event.name.toLowerCase(),
        value: now.getTime() - event.startTime
    };

    if (latencyEvent.value >= 0) {
        // Add the event to be aggregated the next time we flush
        this._addEvent(latencyEvent);
    } else {
        var summary = 'Event with negative latency reported.';
        var detail = core.stringify({
            name: latencyEvent.name,
            value: latencyEvent.value,
            start: event.startTime,
            end: now.getTime(),
            stack: new Error('').stack
        });
        this.logger.warn(logSource, summary, detail);        
    }
};

Metrics.prototype.event = function (name) {
    name = name.toLowerCase();

    var event = {
        name,
        value: 0 // Events that are triggered via this function are for counting only
    };

    this._addEvent(event);
};

Metrics.prototype.logInstallation = function (installationID) {
    this.installations.log(installationID);
};

Metrics.prototype._addEvent = function (event) {
    // Get the event to change from the metrics data structure
    var targetEvent = this.events[event.name];
    
    if (targetEvent) {
        targetEvent.min = Math.min(targetEvent.min, event.value);
        targetEvent.max = Math.max(targetEvent.max, event.value);
        targetEvent.avg += event.value; // average is calculated in the _aggregate method until then it is sum
        targetEvent.count++;

    } else {
        // no existing event. Use this as base event.
        this.events[event.name] = {
            min: event.value,
            max: event.value,
            avg: event.value,
            count: 1
        };

    }
};

// Aggregates all metrics in the metrics data structure and returns a final list of events to fire to the logging service
Metrics.prototype._aggregate = function () {
    // Create an empty array of events to send to the logging service
    var events = [];

    // Calculate the timestamp for all events once
    var eventTimestamp = new Date();

    // For each event type (based on name) calculate the average and prepare the event
    for (var name in this.events) {
        var targetEvent = this.events[name];
            
        // Assign the name property
        targetEvent.name = name;

        // Calculate the average value and set the timestamp
        targetEvent.avg /= targetEvent.count;
        targetEvent.timecreated = eventTimestamp;

        events.push(targetEvent);
    }

    return events;
};

Metrics.prototype.flush = function () {
    // If the event count is greater than 0, then aggregate and flush
    if (Object.keys(this.events).length > 0) {
        this.logger.logMetrics(this._aggregate());
        
        // Reset the metrics object to begin accepting new events
        this.reset();
    }

    this.installations.flush();
};

// This component is responsible for batching and reporting
// installation ID metrics to the logging service.
// Note that this communication is temporary - once our backend
// secure installation monitoring infrastructure is online,
// these metrics will come from there, not the runtime.
function InstallationsProcessor(logger) {
    this.logger = logger;

    this.idBatch = [];
    this.maxBatchSize = 1000;
    this.maxCacheSize = 50 * 1000;
    this.cachePurgePercentage = 0.25;

    this._resetCache();
}

InstallationsProcessor.prototype.log = function (installationID) {
    // normalize case
    installationID = installationID.toLowerCase();

    this._purgeCacheIfNecessary();
    
    // determine if the ID is new
    var isNewID = !this.idCache[installationID];

    if (isNewID) {
        // we haven't seen this ID before, so add it to
        // the ID cache
        this.idCache[installationID] = true;
        this.idCacheCount++;

        // add to the pending batch
        this.idBatch.push(installationID);

        if (this.idBatch.length >= this.maxBatchSize) {
            // we've reached the max threshold size so
            // flush immediately
            this.flush();
        }
    }
};

InstallationsProcessor.prototype.flush = function () {
    if (this.idBatch.length > 0) {
        // we're logging with LogLevel.Off since that is the highest log
        // level and will ensure the entry is logged
        var ids = core.stringify(this.idBatch);
        this.logger.log(LogLevel.Off, LogType.Information, logSource, 'installation-ids', ids);
        this.idBatch = [];
    }
};

InstallationsProcessor.prototype._purgeCacheIfNecessary = function (date) {
    // if the cache has been active for 1 day
    // purge it completely
    var now = date || new Date();
    if (now > this.cacheExpiry) {
        this._resetCache();
        return;
    }

    if (this.idCacheCount >= this.maxCacheSize) {
        // we're over size. determine the amount to purge
        var numToPurge = this.idCacheCount * this.cachePurgePercentage;
        
        // purge the ids
        var keys = Object.keys(this.idCache);
        for (var i = 0; i < numToPurge; i++) {
            delete this.idCache[keys[i]];
            this.idCacheCount--;
        }
    }
};

InstallationsProcessor.prototype._resetCache = function () {
    this.idCache = {};
    this.idCacheCount = 0;
    this._setCacheExpiry();
};

InstallationsProcessor.prototype._setCacheExpiry = function (date) {
    var expiry = date || this._addDays(new Date(), 1);
    this.cacheExpiry = expiry;
};

InstallationsProcessor.prototype._addDays = (date, days) => // return a new date with the specified number of
// days added to the specified date
new Date(date.setDate(date.getDate() + days));