// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module contains helper method for converting zumo style success/error option object into node style async callback.

var _ = require('underscore');

var _str = require('underscore.string');
var scriptErrors = require('./scripterror');

_.mixin(_str.exports());

var ZumoCallback = {};

exports = module.exports = ZumoCallback;

ZumoCallback.moduleFailFormat = "Call into %s Module failed - %s";

// given an options object with success and error function properties, it returns a node style async callback function
// with signature as function(err, result){} that calls the success and error function when the callback is called
// context is an object with following structure:
// {
//    logger: {},
//    metrics: {},
//    responseCallback: function(logger, req, res, error, result, statusCode, additionalHeaders) {...}
// }
// logSource is the source string for sys log entrires
// source is the name of the script where the callback is running for user log entries
// moduleName is name of object that receives this callback on its method i.e. mpns, wns, apn 
// options is the options object that needs to be transformed into node style callback
// visitError is a function(error){...} that will be called before error callback is called
// visitResult is a function(result){...} that will be called before success callback is called
ZumoCallback.create = (
    context,
    logSource,
    source,
    moduleName,
    method,
    options,
    visitError,
    visitResult
) => {
    if (typeof options.success !== 'undefined' && !_.isFunction(options.success)) {
        context.logger.trace(logSource, _.sprintf(ZumoCallback.moduleFailFormat, moduleName, "Invalid success callback option"), ZumoCallback.getTraceDetails(source, method));
        throw new core.MobileServiceError('The options.success callback, if specified, must be a function.', core.ErrorCodes.ScriptError);
    }

    if (typeof options.error !== 'undefined' && !_.isFunction(options.error)) {
        context.logger.trace(logSource, _.sprintf(ZumoCallback.moduleFailFormat, moduleName, "Invalid error callback option"), ZumoCallback.getTraceDetails(source, method));
        throw new core.MobileServiceError('The options.error callback, if specified, must be a function.', core.ErrorCodes.ScriptError);
    }

    return (error, result) => {
        // visit error and result
        if (error && visitError) {
            error = visitError(error);
        }
        else if (result && visitResult) {
            result = visitResult(result);
        }

        // call appropriate user callback
        try {
            if (error) {
                context.metrics.event(_.sprintf("api.%s.error", moduleName));
                var traceDetails = ZumoCallback.getTraceDetails(source, method, error);
                if (options.error) {
                    context.logger.trace(logSource, _.sprintf(ZumoCallback.moduleFailFormat, moduleName, "Calling user error callback"), traceDetails);
                    options.error(scriptErrors.prepareUserError(error));
                } else {
                    context.logger.trace(logSource, _.sprintf(ZumoCallback.moduleFailFormat, moduleName, "No user callback specified"), traceDetails);
                    scriptErrors.handleScriptError(new core.MobileServiceError(error, core.ErrorCodes.ScriptError), source, context.logger, context.responseCallback);
                }
            } else if (options.success) {
                context.metrics.event(_.sprintf("api.%s.success", moduleName));
                context.logger.trace(logSource, _.sprintf("Call into %s Module was successful", moduleName), ZumoCallback.getTraceDetails(source, method));
                options.success(result);
            }
        } catch (ex) {
            context.logger.trace(logSource, _.sprintf("Call into %s user callback threw an exception", moduleName), ZumoCallback.getTraceDetails(source, method));
            scriptErrors.handleScriptError(new core.MobileServiceError(ex, core.ErrorCodes.ScriptError), source, context.logger, context.responseCallback);
        }
    };
};

ZumoCallback.getTraceDetails = (source, method, error) => {
    var details = {
        source
    };

    if (method) {
        details.method = method;
    }

    if (error) {
        details.error = error.toString();
    }

    return details;
};

// This method wraps an object's methods to replace any callbacks with Zumo-style option callbacks.
// It will wrap the passed in object and 1 level of sub-property's methods
// - objectToWrap is the object to wrap (Example: pushNotificationService)
// - moduleNamePrefix -- is passed to logger and metrics for tracking the moduleName (Example: 'push.nh')
// - logSource -- Used for logging source string (Example: 'Push')
// - source -- is used for logs to identify the route
// - logger, -- Used to log
// - metrics -- Used to report metrics
// - allowedMethodPrefix -- Which method prefixes will be wrapped. (Example: ['send', 'receive']
// - disallowedMethodPrefix -- Which methods that match allowed will be excluded because they have no callback (Example: ['sendNull'])
// - responseCallback, -- is the request's default responseCallback in case user does not provice a callback
ZumoCallback.wrapObject = (
    objectToWrap,
    moduleNamePrefix,
    logSource,
    source,
    logger,
    metrics,
    allowedMethodPrefixes,
    disallowedMethodPrefixes,
    responseCallback
) => {
    var wrapperObject = {};
    for (var prop in objectToWrap) {
        // if this is a method that should be wrapped, wrap it
        if (shouldWrapMethod(prop, objectToWrap, allowedMethodPrefixes, disallowedMethodPrefixes)) {
            wrapperObject[prop] = wrapperMethod.bind(objectToWrap, logSource, source, logger, metrics, responseCallback, moduleNamePrefix, prop, objectToWrap[prop]);
        }
            // if not a method and an object, check its methods for wrapping
        else if (_.isObject(objectToWrap[prop])) {
            for (var subProp in objectToWrap[prop]) {
                // a method to wrap was found
                if (shouldWrapMethod(subProp, objectToWrap[prop], allowedMethodPrefixes, disallowedMethodPrefixes)) {
                    // ensure there is a property of matching name to place the method in
                    if (_.isUndefined(wrapperObject[prop])) {
                        wrapperObject[prop] = {};
                    }
                    // wrap the method
                    wrapperObject[prop][subProp] = wrapperMethod.bind(objectToWrap[prop], logSource, source, logger, metrics, responseCallback, moduleNamePrefix + '.' + prop, subProp, objectToWrap[prop][subProp]);
                }
            }
        }
    }

    return wrapperObject;
};

// transform method call to fit ZUMO esthetics:
// - this should be bound to the wrappedObject
// - logSource is used for user logs
// - source is used for logs to identify the route
// - logger is used to log user and system logs
// - metrics is used to log metrics
// - responseCallback is the request's default responseCallback in case user does not provice a callback
// - moduleName is passed to logger and metrics for tracking the moduleName
// - methodName is the name of the method being wrapped
// - wrappedMethod is the method that will be invoked
// - (optional) extra arguments are passed through to the wrapped method
//      * success and error callbacks are separate and specified as properties of the options object which is last argument
function wrapperMethod(logSource, source, logger, metrics, responseCallback, moduleName, methodName, wrappedMethod) {
    // pull any args after those fed to this method
    var args = Array.prototype.slice.call(arguments, 8);
    
    metrics.event(_.sprintf('api.%s.%s', moduleName, methodName));

    // inspect last argument to hunt for callbacks.
    var options = {};
    if (args.length > 0) {
        var lastArg = args[args.length - 1];
        if (_.isObject(lastArg)) {
            options = _.pick(lastArg, 'success', 'error');

            // if callbacks exist, remove them from last argument
            if (!_.isEmpty(options)) {
                delete lastArg.success;
                delete lastArg.error;
            }
            
            if (_.isEmpty(lastArg)) {
                args.pop();
            }
        }
    }

    // create callback
    var callback = ZumoCallback.create({ metrics, logger, responseCallback }, logSource, source, moduleName, methodName, options);
    args.push(callback);

    try {
        // finally call the wrapped method
        return wrappedMethod.apply(this, args);
    } catch (ex) {
        logger.trace(logSource, _.sprintf('Call into %s Module failed - module method invocation threw', moduleName), ZumoCallback.getTraceDetails(source, methodName, ex));
        throw ex;
    }
}

// returns true if methodObject[name] is a function 
// starting with allowedMethod prefix, but not starting with disallowedMethods prefix
function shouldWrapMethod(methodName, methodObject, allowedMethodPrefixes, disallowedMethodPrefixes) {
    return _.isFunction(methodObject[methodName]) &&
        methodNamePrefixInList(methodName, allowedMethodPrefixes) &&
        !methodNamePrefixInList(methodName, disallowedMethodPrefixes);
}

// returns true if if the methodName starts with any string in methodPrefixList and false otherwise
function methodNamePrefixInList(methodName, methodPrefixList) {
    return _.find(methodPrefixList,
        methodPrefix => _str.startsWith(methodName, methodPrefix));
}