// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is encapsulates the data operations invoked by scripts.

var Query = require('../Zumo.Node').Query;

var scriptErrors = require('../script/scripterror');
var StatusCodes = require('../statuscodes').StatusCodes;
var resource = require('../resources');
var core = require('../core');
var _ = require('underscore');
var _str = require('underscore.string');

_.mixin(_str.exports());

exports = module.exports = DataOperation;

var logSource = 'DataOperation';

function DataOperation(storage, source, logger) {
    this.storage = storage;
    this.source = source;
    this.logger = logger;
}

DataOperation.prototype.insert = function (table, item, options, responseCallback, scriptCallback) {
    this.operation = 'insert';
    var storageCallback = this.createStorageCallback(table, StatusCodes.CREATED, responseCallback, scriptCallback);
    this.logger.trace(logSource, 'Beginning insert operation');
    this.storage.insert(table, item, this.logger, options, storageCallback);
};

DataOperation.prototype.read = function (table, query, options, responseCallback, scriptCallback) {
    var self = this;

    // if there is a projection defined on the query, intercept the
    // script callback to do result transformation
    var projection;
    if (query && query.constructor === Query) {
        projection = query.getComponents().projection;
    }

    var responseEvaluator = results => {
        if (query.id !== undefined && results && (results.length === 0)) {
            return { error: self._handleItemNotFound(query.id) };
        } else { 
            if (projection && results) {
                for (var i = 0; i < results.length; i++) {
                    results[i] = projection.call(results[i]);
                }
            }

            return { results };
        }
    };

    query = self.unwrapQueryBuilder(query);
    if (query.table === undefined || query.table === null) {
        // we default to actual table for the request, but
        // we support the user redirecting to another table
        query.table = table;
    }

    this.operation = 'read';
    var storageCallback = self.createStorageCallback(table, StatusCodes.OK, responseCallback, scriptCallback, responseEvaluator);
    this.logger.trace(logSource, 'Beginning read operation');
    this.storage.query(query, this.logger, options, storageCallback);
};

DataOperation.prototype.update = function (table, item, options, responseCallback, scriptCallback) {
    var self = this;

    var responseEvaluator = rowCount => {
        if (rowCount === 0) {
            return { error: self._handleItemNotFound(item.id) };
        } else {
            return { results: item };
        }
    };

    this.operation = 'update';
    var storageCallback = this.createStorageCallback(table, StatusCodes.OK, responseCallback, scriptCallback, responseEvaluator);
    this.logger.trace(logSource, 'Beginning update operation');
    this.storage.update(table, item.id, item, this.logger, options, storageCallback);
};

DataOperation.prototype.del = function (table, itemOrId, options, responseCallback, scriptCallback) {
    var self = this;
    var id = itemOrId;
    var version = null;

    if (core.isObject(itemOrId))
    {
        id = itemOrId.id;
        version = itemOrId.__version;
    }

    var responseEvaluator = rowCount => {
        if (rowCount === 0) {
            return { error: self._handleItemNotFound(id) };
        } else {
            return { results: null };
        }
    };

    this.operation = 'delete';
    var storageCallback = this.createStorageCallback(table, StatusCodes.NO_CONTENT, responseCallback, scriptCallback, responseEvaluator);
    this.logger.trace(logSource, 'Beginning delete operation');
    this.storage.del(table, id, version, this.logger, options, storageCallback);
};

function unwrapInlineCount(results) {
    // If the client used includeTotalCount to pass $inlinecount=allpages,
    // our response will be an object like { results: [ ... ], count: n }
    // and we want to unwrap the array before passing it on to the
    // callbacks so they don't have to always have to do various type
    // checking before using the results.
    var scriptResults = results;
    if (results &&
        !Array.isArray(results) &&
        typeof results.count !== 'undefined' &&
        typeof results.results !== 'undefined') {

        // Create a new total count property on the results array
        Object.defineProperty(results.results, 'totalCount', { value: results.count });
        scriptResults = results.results;
    }
    return scriptResults;
}

DataOperation.prototype.createStorageCallback = function (table, successCode, responseCallback, scriptCallback, responseEvaluator) {
    var self = this;
    return (err, results) => {
        if (typeof responseEvaluator === 'function' && !err) {
            // Use the passed in response evaluator function to update the error
            // and results objects passed back from the storage layer.
            // The responseEvaluator is expected to return an object in the form of:
            // { error: value, results: value }
            // After we get this response, we will replace the existing values
            // with what is returned by the evaluator.
            var evaluatedResponse = responseEvaluator(results);

            // Assign the new values to err and results
            err = evaluatedResponse.error;
            results = evaluatedResponse.results;
        }

        try {
            if (typeof scriptCallback === 'function') {
                var scriptResults = unwrapInlineCount(results);
                scriptCallback(err, scriptResults);
            }
        } catch (e) {
            var msg = _.sprintf("Error in callback for table '%s'.", table);

            // If the caught error isn't a MobileServiceError, then wrap it
            var error = e;
            if (e.constructor !== core.MobileServiceError) {
                error = new core.MobileServiceError(e, core.ErrorCodes.ScriptError);
            }

            scriptErrors.handleScriptError(error, self.source, self.logger, responseCallback, msg);
            return;
        }

        // Call the responseCallback which will decide if the results should be written to the response or not.
        if (typeof responseCallback === 'function') {
            responseCallback(err, results, err ? undefined : successCode);
        }
    };
};

// if the specified query is a query builder, convert it back to our
// query representation
DataOperation.prototype.unwrapQueryBuilder = query => {
    if (query && query.constructor === Query) {
        var unwrapped = {};

        // Default to values on the literal query object
        if (query.id || query.id === 0) unwrapped.id = query.id;
        if (query.table) unwrapped.table = query.table;
        if (query.filter) unwrapped.filter = query.filter;
        if (query.select && typeof (query.select) !== 'function') unwrapped.select = query.select;
        if (query.orderBy && typeof (query.orderBy) !== 'function') unwrapped.orderBy = query.orderBy;
        if (query.top || query.top === 0) unwrapped.top = query.top;
        if ((query.skip || query.skip === 0) && typeof (query.skip) !== 'function') unwrapped.skip = query.skip;
        if (query.inlineCount || query.inlineCount === 0) unwrapped.inlineCount = query.inlineCount;

        var odata = Query.Providers.OData.toOData(query);
        if (odata.table) unwrapped.table = odata.table;
        if (odata.filters) unwrapped.filter = odata.filters;
        if (odata.selections) unwrapped.select = odata.selections;
        if (odata.ordering) unwrapped.orderBy = odata.ordering;
        if (odata.take || odata.take === 0) unwrapped.top = odata.take;
        if (odata.skip || odata.skip === 0) unwrapped.skip = odata.skip;
        if (odata.includeTotalCount) unwrapped.inlineCount = 'allpages';

        if (query._parsed) {
            if (query._parsed.version === query.getComponents().version) {
                // only if the current query version is the same as
                // the cached version of the query when it was parsed
                // do we want to use the parsed query
                unwrapped._parsed = query._parsed;
            }
        }

        query = unwrapped;
    }

    return query;
};

DataOperation.prototype._handleItemNotFound = id => new core.MobileServiceError(_.sprintf(resource.itemNotFound, id.toString()), core.ErrorCodes.ItemNotFound);
