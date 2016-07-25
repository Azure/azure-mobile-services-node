// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is responsible for loading and exposing custom apis on the app

var StatusCodes = require('../statuscodes').StatusCodes,
    path = require('path'),
    core = require('../core'),
    Metadata = require('./metadata'),
    scriptErrors = require('./scripterror'),
    ScriptLoader = require('./scriptloader'),
    _ = require('underscore'),
    _str = require('underscore.string'),
    allowHandler = require('../request/middleware/allowhandler');

_.mixin(_str.exports());

exports = module.exports = ApiBuilder;

var logSource = 'ApiBuilder';

// We support both 'delete' and 'del', but alias 'del' to 'delete'
var supportedHttpMethods = Metadata.supportedHttpMethods.concat(["del"]);

function ApiBuilder(app, middleware, scriptManager, logger, metrics) {
    this.app = app;
    this.middleware = middleware;
    this.scriptManager = scriptManager;
    this.metrics = metrics;
    this.logger = logger;
    this.apis = {};
}

ApiBuilder.prototype.build = function (done) {
    var self = this;

    var options = {
        error: this._handleLoadError.bind(this),
        load: this._handleFileLoad.bind(this, supportedHttpMethods)
    };

    this.scriptManager.scriptLoader.loadScriptDirectory('api', options, done);
};

ApiBuilder.prototype._handleLoadError = function (err, scriptInfo) {
    if (!(scriptInfo && scriptInfo.name)) {
        throw err; // there is no script information so we let it bubble up to global handler    
    }

    var isScript = isScriptFile(scriptInfo.scriptFileName);
    if (isScript) {
        // because we failed to load the api we will create a fake module that throws a file load error on invocation
        scriptInfo.module = {
            all: apiLoadErrorHandler
        };
    }
    else {
      scriptInfo.module = null;
    }

    this._handleFileLoad(['all'], scriptInfo);
};

// callback for file load events from script loader
ApiBuilder.prototype._handleFileLoad = function (supportedMethods, scriptInfo) {
    // get or create the api entry for this file
    var api = this.apis[scriptInfo.name] || createApi(scriptInfo),
        isScript = isScriptFile(scriptInfo.scriptFileName);

    if (isScript) {
        this._loadApi(supportedMethods, api);
    }
    else { // its a metdata file
        if (!scriptInfo.module) {
            api.error = _.sprintf("Failed to load metadata file '%s'.", scriptInfo.scriptFileName);
        }
        else {
            api.metadata = scriptInfo.module;
        }
    }
};

ApiBuilder.prototype._loadApi = function (supportedMethods, api) {
    var scriptPath = api.scriptPath,
        baseRoute = '/api/' + api.name,
        scriptSource = '/api/' + api.scriptFileName,
        self = this;

    api.baseRoute = baseRoute;
    api.reset();  // clear any existing routes
    this.apis[api.name] = api;
    
    // clone the base middleware to and add additional to define
    // the common set of middleware for this api
    var middleware = self.middleware.slice(0) || [];
    middleware.unshift(core.curry(requirePermission, api));
    middleware.push(core.curry(prepareRequest, api, self.scriptManager));

    // add the route to the api and mount it on the app
    function addRoute(method, route, middleware, handler) {
        // alias 'del' to 'delete' to ensure parity with the table apis
        if (method === 'del') {
            method = 'delete';
        }

        api.addRoute(route, method);

        handler = _.wrap(handler, function (originalHandler, req, res) {
            var logger = req._context.logger,
                metrics = req._context.metrics,
                responseCallback = req._context.responseCallback;

            logger.trace(logSource, 'Invoking user handler');
            metrics.event(_.sprintf('api.custom.%s', method));

            try {
                // if there was an error loading an api, we wire all requests to fail until the problem is fixed
                if (api.error) {
                    throw new Error(api.error);
                }
                originalHandler(req, res);
            }
            catch (e) {
                // catch any synchronous errors and log to user log
                var error = e;
                if (error.constructor !== core.MobileServiceError) {
                    error = new core.MobileServiceError(e, core.ErrorCodes.ScriptError);
                }
                scriptErrors.handleScriptError(error, scriptSource, logger, responseCallback);
            }
        });

        self.app[method](route, middleware.concat(handler));
    }

    // define an api wrapper to intercept route registration calls, etc.
    var apiWrapper = {};
    _.each(supportedMethods, function (method) {
        apiWrapper[method] = function (route, handler) {
            if (!_.startsWith(route, '/')) {
                route = '/' + route;
            }
            route = baseRoute + route;
            addRoute(method, route, middleware, handler);
        };
    });

    // first load any explicit routes
    // "explicit" form of a custom api, with an exported register
    // function allowing open ended route registration
    var apiModule = api.module;
    var registerFailed = false;
    if (apiModule.register) {
        try {
            apiModule.register(apiWrapper);
        } catch (e) {
            registerFailed = true;
            ScriptLoader.logScriptLoadError(self.logger, e, 'api', api.scriptFileName);
            // since we don't know what routes the register function would have registered 
            // we configure the api to always error on execution on a public 'all' route
            api.error = "'register' method of the api failed.";            
            addRoute('all', baseRoute, middleware, function (req, res) { });
        }        
    }

    if (!registerFailed) {
        // next load any implicit routes
        // "prescriptive" form of a custom api, with exported functions
        // for each http verb
        _.each(supportedMethods, function (method) {
            var handler = apiModule[method];
            if (handler) {
                addRoute(method, baseRoute, middleware, handler);
            }
        });
    }

    // finally, add an allow handler that will match on all http
    // methods, to send back proper 405 Allow responses
    _.each(api.routes, function (route, path) {
        self.app.all(path, allowHandler(route.methods));
    });
};

// request handler to replace an api that was not successfully loaded due to user error.
function apiLoadErrorHandler(req, res) {
    throw new Error('Error loading the api.');
}

// middleware used to set the required permission on the request,
// based on the permission configured for the api route
function requirePermission(api, req, res, next) {
    var requiredPermission = 'admin',
        logger = req._context.logger,
        parsedRequest = req._context.parsedRequest;

    // if we faild to register the apis or load the metadata file, we don't know what permissions it would have
    // since we're going to return an error from the api, it is safe to make it public
    if (api.error) {
        parsedRequest.requiredPermission = 'public';
    }
    else {
        // chop off the base route to get the sub route to
        // use as search key into route metadata
        var apiSubRoute = req.route.path.substring(api.baseRoute.length) || '/';

        if (api.metadata) {
            if (api.metadata.getRouteMetadata) {
                var routeMetadata = api.metadata.getRouteMetadata(apiSubRoute, req.method);

                if (routeMetadata && routeMetadata.permission) {
                    requiredPermission = routeMetadata.permission || requiredPermission;
                }
            }
            else {
                logger.error('api.metadata.getRouteMetadata method not found for api ' + api.name + ' and metadata ' + JSON.stringify(api.metadata));
            }
        }

        parsedRequest.requiredPermission = requiredPermission;
    }

    next();
}

// middleware used to set up required state on the request before
// calling into user code
function prepareRequest(api, scriptManager, req, res, next) {
    var logger = req._context.logger,
        responseCallback = req._context.responseCallback,
        source = '/api/' + api.scriptFileName;

    // set the executing script on request context
    req._context.script = source;

    // add service to the request
    req.service = scriptManager.buildScriptService(source, logger, { responseCallback: responseCallback });

    // to keep the script apis consistent, we define a 'respond'
    // which delegates to send
    req.respond = function (statusCode, body) {
        res.send(statusCode, body);
    };

    next();
}

// create an api object representing an api script
function createApi(scriptInfo) {
    var api = {
        name: scriptInfo.name,
        scriptFileName: scriptInfo.scriptFileName,
        scriptPath: scriptInfo.scriptPath,
        module: scriptInfo.module,
        routes: []
    };

    api.reset = function () {
        this.routes = {};
    };

    api.addRoute = function (route, method) {
        if (!this.routes[route]) {
            this.routes[route] = { methods: [] };
        }
        if (this.routes[route].methods.indexOf(method) < 0) {
            // prevent duplicates - if the user registers the same
            // route for the same method twice, it'll be last one wins
            this.routes[route].methods.push(method);
        }
    };

    return api;
}

function isScriptFile(fileName) {
    return path.extname(fileName).toLowerCase() === '.js';
}