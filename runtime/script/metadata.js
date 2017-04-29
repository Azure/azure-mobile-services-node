// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// Encapsulates script metadata

var core = require('../core');

var _ = require('underscore');
var _str = require('underscore.string');

_.mixin(_str.exports());

exports = module.exports = Metadata;

var supportedHttpMethods = ['get', 'put', 'post', 'patch', 'delete'];
var tableOperations = ['read', 'insert', 'update', 'delete'];

function Metadata(metadata, filename) {
    this.metadata = metadata;

    validateMetadata(metadata, filename);
}

Metadata.supportedHttpMethods = supportedHttpMethods;
Metadata.tableOperations = tableOperations;

Metadata.prototype.getRouteMetadata = function (route, method) {
    if (this.metadata.routes) {
        var routeMetadata = this._matchRoute(route);

        if (isMethodMap(routeMetadata)) {
            // a map of methods to metadata is assigned to this route
            // lookup and return based on method
            // if an explicit match is not found, try a wildcard match
            return routeMetadata[method.toLowerCase()] || routeMetadata['*'];
        }
        else {
            // if not a method map, or if the route isn't found
            // return the metadata directly
            return routeMetadata;
        }
    }
    return null;
};

Metadata.prototype._matchRoute = function (route) {
    var normalizedRoute = _.trim(route, '/');
    var routeMetadata = null;

    // Search for a route match by normalizing both values 
    // by removing any leading/trailing slashes. E.g., we want
    // match /a/b with a/b or a/b/, etc.
    var matchedRoute = _.chain(this.metadata.routes).keys().find(routeKey => normalizedRoute == _.trim(routeKey, '/')).value();

    if (matchedRoute) {
        routeMetadata = this.metadata.routes[matchedRoute];
    }
    else {
        // if no explicit match, do a wildcard match
        routeMetadata = this.metadata.routes['*'];
    }

    return routeMetadata;
};

function validateMetadata(metadata, fileName) {
    var validMetadataProperties = ['permission'];
    var validPermissions = ['application', 'user', 'authenticated', 'admin', 'public'];

    function throwMetadataError(reason) {
        throw new Error(_.sprintf("Invalid metadata file '%s': %s", fileName, reason));
    }

    function validateRouteMetadata(route, routeMetadata) {
        _.each(routeMetadata, (value, key) => {
            if (validMetadataProperties.indexOf(key) < 0) {
                throwMetadataError(_.sprintf("Invalid route metadata for route '%s'. '%s' is not a valid metadata property.", route, key));
            }
            if (key === 'permission') {
                if (validPermissions.indexOf(value) < 0) {
                    throwMetadataError(_.sprintf("Invalid route metadata for route '%s'. '%s' is not a valid permission level.", route, value));
                }
            }
        });
    }

    var routes = metadata.routes;
    if (!routes) {
        throwMetadataError("Missing 'routes' declaration.");
    }
    if (!core.isObject(routes)) {
        throwMetadataError("'routes' must be an object, mapping routes to route metadata.");
    }

    _.each(routes, (routeMetadata, route) => {
        // validate the route 
        if (!route) {
            throwMetadataError(_.sprintf("Invalid route path '%s'", route));
        }
        if (!core.isObject(routeMetadata)) {
            throwMetadataError(_.sprintf("Invalid route metadata for route '%s'. Route metadata must be an object.", route));
        }

        if (isMethodMap(routeMetadata)) {
            _.each(routeMetadata, (routeMetadataMap, methodOrOp) => {
                if (!isHttpMethodOrTableOperation(methodOrOp)) {
                    throwMetadataError(_.sprintf("Invalid route metadata for route '%s'. '%s' is not a supported http method or table operation.", route, methodOrOp));
                }
                validateRouteMetadata(route, routeMetadataMap);
            });
        }
        else {
            validateRouteMetadata(route, routeMetadata);
        }
    });
}

function isHttpMethodOrTableOperation(methodOrOp) {
    return supportedHttpMethods.indexOf(methodOrOp.toLowerCase()) >= 0 ||
           tableOperations.indexOf(methodOrOp.toLowerCase()) >= 0 ||
           methodOrOp == '*';
}

// returns true if the specified object looks like an
// method metadata map, mapping http methods or table operations
// to metadata
function isMethodMap(obj) {
    if (!obj) {
        return false;
    }

    function keyInObject(key) {
        return key in obj;
    }

    if (supportedHttpMethods.some(keyInObject) ||
        tableOperations.some(keyInObject) ||
        keyInObject('*')) {
        return true;
    }

    return false;
}
