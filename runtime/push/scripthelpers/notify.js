// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is the base for sending push notifications via Windows Azure Mobile Services
// WNS, MPNS, and APNS all use this module to build out their notification client objects.

var StatusCodes = require('../../statuscodes').StatusCodes;

var core = require('../../core');
var scriptErrors = require('../../script/scripterror');
var ZumoCallback = require('../../script/zumocallback');
var _ = require('underscore');
var _str = require('underscore.string');

_.mixin(_str.exports());

var logSource = "Push";

// transform methods to fit ZUMO esthetics:
// - success and error callbacks are separate and specified as properties of the options object
// - user can call these methods either with a single channel URL (or deviceToken) or with an array of channels (or deviceTokens)
exports.createWrapper = (
    module,
    method,
    argsLength,
    moduleName,
    visitResult,
    visitOptions,
    disableAtomizingChannelArrays,
    skipModuleOptions,
    finalizeArgs
) => {
    var wrapper = function () {
        // Copy the arguments array and extract the pipelineContext
        var args = Array.prototype.slice.call(arguments);
        var pipelineContext = args.shift();
        var empty = {};
        pipelineContext.logger.trace(logSource, _.sprintf('Creating %s Module', moduleName), ZumoCallback.getTraceDetails(pipelineContext.scriptSource, method));
        pipelineContext.metrics.event(_.sprintf('api.%s.%s', moduleName, method));

        // if first argument is an array and channel array atomization is not disabled, call self recursively for each of the elements
        if (Array.isArray(args[0]) && !disableAtomizingChannelArrays) {
            var channels = args[0];
            // Add the context object back
            args.unshift(pipelineContext);
            channels.forEach(function (channel) {
                // Set the channel for this specific call
                args[1] = channel;
                wrapper.apply(this, args);
            });

            return;
        }        

        // do not bother adding options and callback if there is insufficient number of parameters passed
        // it will fail anyways
        if (args.length > argsLength - 1) {
            // determine if the optional options object is passed as the last parameter, assume empty if not
            var options;
            if (args.length > argsLength && typeof args[args.length - 1] === 'object') {
                options = args[args.length - 1];
            }
            else {
                options = empty;
            }

            var visitor = errOrResult => {
                if (visitResult) {
                    errOrResult = visitResult(errOrResult, args);
                }
                return errOrResult;
            };

            var callback = ZumoCallback.create(pipelineContext,
                                               logSource,
                                               pipelineContext.scriptSource,
                                               moduleName,
                                               method,
                                               options,
                                               visitor,
                                               visitor);

            if (skipModuleOptions) {
                // the module does not take any options; if options were specified in arguments, replace them with callback
                // otherwise add callback to the end of the argument list

                if (options === empty) {
                    Array.prototype.push.call(args, callback);
                }
                else {
                    args[args.length - 1] = callback;
                }
            }
            else {
                // create options
                var moduleOptions = {};
                for (var i in options) {
                    moduleOptions[i] = options[i];
                }

                if (visitOptions) {
                    visitOptions(moduleOptions);
                }

                // massage arguments array to modify signature
                if (options === empty) {
                    Array.prototype.push.call(args, moduleOptions);
                }
                else {
                    args[args.length - 1] = moduleOptions;
                }

                Array.prototype.push.call(args, callback);
            }            
        }

        if (finalizeArgs) {
            try {
                finalizeArgs(args);
            }
            catch (ex) {
                pipelineContext.logger.trace(logSource, _.sprintf(ZumoCallback.moduleFailFormat, moduleName, "finalizeArgs threw"), ZumoCallback.getTraceDetails(pipelineContext.scriptSource, method, ex));
                throw ex;
            }
        }

        try {
            // finally call the module method
            return module[method].apply(this, args);
        } catch (ex) {
            pipelineContext.logger.trace(logSource, _.sprintf(ZumoCallback.moduleFailFormat, moduleName, "module method invocation threw"), ZumoCallback.getTraceDetails(pipelineContext.scriptSource, method, ex));
            throw ex;
        }
    };

    return wrapper;
};

exports.createWrappedClient = (module, source, logger, metrics, responseCallback) => {

    // We instantiate the push client (wns, mpns, etc) when the server starts but we need to provide logging
    // and responseCallbacks per request. In this method we are wrapping the client with
    // methods which pass per response information into each client method.

    // Create the pipeline context object
    var pipelineContext = {
        logger,
        responseCallback,
        scriptSource: source,
        metrics
    };

    // Curry the pipelineContext object into every method
    var wrappedClient = {};
    var functions = Object.getOwnPropertyNames(module);
    for (var func in functions) {
        var name = functions[func];
        if (typeof module[name] === 'function') {
            wrappedClient[name] = core.curry(module[name], pipelineContext);
        }
    }

    return wrappedClient;
};