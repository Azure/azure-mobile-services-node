// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module provides functions to parse a request into a request object used by the runtime.

((global => {
    require('../query/queryparser');

    var _ = require('underscore');
    var _str = require('underscore.string');
    var core = require('../core');

    _.mixin(_str.exports());

    // Parses the specified request into our request object
    function parse(req) {
        var applicationKeyHeaderName = 'x-zumo-application';
        var masterKeyHeaderName = 'x-zumo-master';
        var authenticationHeaderName = 'x-zumo-auth';
        var noScriptParamName = 'noScript';

        var request = {
            url: req.url,
            verb: req.method,
            headers: req.headers
        };

        if (req.params && req.params.operation) {
            request.operation = req.params.operation.toLowerCase();
        }

        // only parse the query for tables
        if (request.operation === 'tables' && req.query && Object.keys(req.query).length > 0) {
            var noScriptValue = getQueryParamIgnoreCase(noScriptParamName, req.query);
            if (noScriptValue) {
                request[noScriptParamName] = noScriptValue;
            }
            request.query = parseQuery(req.query, request.verb);
        } 
        else {
            request.query = {};
        }

        if (request.headers) {
            request.masterKey = request.headers[masterKeyHeaderName];
            request.applicationKey = request.headers[applicationKeyHeaderName];
            request.authenticationKey = request.headers[authenticationHeaderName];
        }

        request._context = req._context;

        return request;
    }

    // We want our non-odata query params to be case insensitive. Odata is case
    // sensitive (Odata spec behavior). All our other url components are also case
    // insensitive (operation names, table names, etc.)
    function getQueryParamIgnoreCase(param, query) {
        for (var currParam in query) {
            if (param.toLowerCase() === currParam.toLowerCase()) {
                return query[currParam];
            }
        }
        return null;
    }

    function validateQuery(request) {
        if (request.query) {
            // validate the query
            if (request.id !== undefined) {
                // query options cannot be applied to id queries
                if (request.query.inlineCount || request.query.skip || request.query.top || request.query.orderBy) {
                    throw new core.MobileServiceError('Query options $orderby, $inlinecount, $skip and $top cannot be applied to id queries.', core.ErrorCodes.BadInput);
                }

            } else if (request.query.top > 1000) {
                // Note that we're only imposing this limit on queries originating externally,
                // not on server side initiated queries.
                throw new core.MobileServiceError('The value of the $top query option cannot exceed 1000.', core.ErrorCodes.BadInput);
            } else if (request.query.top < 0) {
                throw new core.MobileServiceError('The value of the $top query option must be greater or equal to 0.', core.ErrorCodes.BadInput);
            }
        }
    }

    function parseQuery(query, verb) {
        var queryObject = {
            parameters: {},
            systemProperties: [],
            includeDeleted: false
        };

        for (var option in query) {
            var value = query[option];

            if (verb != 'GET' && isODataQueryOption(option)) {
                // skip any OData options incorrectly specified for non
                // GET operations, so we don't do unecessary parsing below
                continue;
            }

            switch (option) {
                case '$filter':
                case '$select':
                    queryObject[option.slice(1)] = value;
                    break;
                case '$orderby':
                    // TODO: we have a potential casing issue here. I'd like for the property to be
                    // camel cased. Need to make sure we're doing this consistently everywhere.
                    queryObject.orderBy = value;
                    break;
                case '$skip':
                case '$top':
                    queryObject[option.slice(1)] = core.parseNumber(value, option);
                    break;
                case '$inlinecount':
                    queryObject.inlineCount = parseInlineCount(value);
                    break;
                default:
                    if (option.toLowerCase() === '__systemproperties') {
                        queryObject.systemProperties = core.validateAndNormalizeSystemProperties(value.split(','));
                    }
                    else if (option.toLowerCase() === '__includedeleted') {
                        queryObject.includeDeleted = core.parseBoolean(value || 'false');
                    }
                    else if (option.match(/^(?:\$|__)/)) {
                        throw new core.MobileServiceError(_.sprintf("Invalid query parameter name '%s'. Custom query parameter names must not start with $ or __.", option), core.ErrorCodes.BadInput);
                    } else {
                        queryObject.parameters[option] = value;
                    }
                    break;
            }
        }

        // Verify that the query is valid by parsing its components.
        // Any failures to parse will result in an exception. We want
        // to do this early in the pipeline to ensure the request is
        // completely valid before executing user code.
        // The parsed query is then saved for use later in the pipeline
        // (we don't reparse it)
        try {
            if (queryObject.filter) {
                queryObject._parsed = queryObject._parsed || {};
                queryObject._parsed.filter = QueryParser.filter(queryObject.filter);
            }

            if (queryObject.orderBy) {
                queryObject._parsed = queryObject._parsed || {};
                queryObject._parsed.orderBy = QueryParser.orderBy(queryObject.orderBy);
            }
        }
        catch (e) {
            throw new core.MobileServiceError('Invalid query specified. ' + e, core.ErrorCodes.BadInput);
        }

        return queryObject;
    }

    function parseInlineCount(value) {
        if (value === 'allpages' || value === 'none') {
            return value;
        }
        throw new core.MobileServiceError("The value specified for inlinecount must be either 'allpages' or 'none'.", core.ErrorCodes.BadInput);
    }

    function isODataQueryOption(option) {
        switch (option) {
            case '$filter':
            case '$select':
            case '$orderby':
            case '$skip':
            case '$top':
            case '$inlinecount':
                return true;
            default:
                return false;
        }
    }

    Request = global;
    Request.parse = parse;
    Request.validateQuery = validateQuery;
}))(typeof exports === "undefined" ? (this.Request = {}) : exports);
