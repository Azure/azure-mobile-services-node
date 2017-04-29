// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is responsible for processing HTTP requests end to end. Delegates to specific
// handler modules to process different request types (e.g. tables, scheduler, api, login, etc.)

var core = require('../core');

var TableHandler = require('./tablehandler');
var LoginHandler = require('./loginhandler');
var SchedulerHandler = require('./schedulerhandler');
var StatusHandler = require('./statushandler');
var DiagnosticsHandler = require('./diagnosticshandler');
var CrossDomainHandler = require('./html/crossdomainhandler');
var ApiBuilder = require('../script/apibuilder');
var util = require('util');
var StatusCodes = require('../statuscodes').StatusCodes;
var fileHelpers = require('../filehelpers');
var CorsHelper = require('./html/corshelper');
var UserService = require('../users/userservice');
var _ = require('underscore');
var _str = require('underscore.string');
var Logger = require('../logger');
var uuid = require('request/uuid');
var resources = require('../resources');
var express = require('express');
var allowHandler = require('./middleware/allowhandler');
var bodyParser = require('./middleware/bodyparser');
var requestLimit = require('./middleware/requestlimit');
var errorHandler = require('./middleware/errorhandler');
var authenticate = require('./middleware/authenticate');
var authorize = require('./middleware/authorize');
var versionCheck = require('./middleware/versioncheck');
var requireHttpsMiddleware = require('./middleware/requirehttps');
var EtagHelper = require('./etaghelper.js');
var ErrorHelper = require('./errorhelper.js');
var Request = require('./request.js');

_.mixin(_str.exports());

exports = module.exports = RequestHandler;

var logSource = 'RequestHandler';
var version = null;
var npmPackageVersion = require('../../package.json').version;

function RequestHandler(configPath, masterKey, systemKey, appName, authenticationCredentials, crossDomainWhitelist, applicationKey, runtimeVersion, requestTimeout, storage, scriptManager, logger, metrics, logLevel, logServiceURL, logServiceToken, maxRequestBodySize, newRelicAdapter, userService, pushAdapter, domainSuffix, requireHttps, skipVersionCheck) {
    this.requestTimeout = requestTimeout || 30 * 1000;
    this.storage = storage;
    this.scriptManager = scriptManager;
    this.configPath = configPath;
    this.logger = logger;
    this.metrics = metrics;
    this.logLevel = logLevel;
    this.logServiceURL = logServiceURL;
    this.logServiceToken = logServiceToken;
    this.maxRequestBodySize = maxRequestBodySize;
    this.newRelicAdapter = newRelicAdapter;
    this.userService = userService || UserService.nullService;
    this.corsHelper = new CorsHelper({ crossDomainWhitelist });
    this.domainSuffix = typeof domainSuffix != "undefined" ? domainSuffix : null;
    this.requireHttps = typeof(requireHttps) === 'string' && requireHttps.toLowerCase() === 'true';
    this.skipVersionCheck = skipVersionCheck;

    version = runtimeVersion || "development";

    this.tableHandler = new TableHandler(storage, scriptManager, metrics);
    this.loginHandler = new LoginHandler(authenticationCredentials, masterKey, this.corsHelper, logger, this.userService, this.domainSuffix);
    this.schedulerHandler = new SchedulerHandler(scriptManager, masterKey, appName, metrics);
    this.statusHandler = new StatusHandler();
    this.diagnosticsHandler = new DiagnosticsHandler(appName, version, storage);
    this.crossDomainHandler = new CrossDomainHandler(this.corsHelper);
    this.pushAdapter = pushAdapter;

    this.keys = {
        masterKey,
        applicationKey,
        systemKey
    };
}

RequestHandler.prototype.initialize = function (app, extensionManager, done) {
    var self = this;

    this.extensionManager = extensionManager;

    this.nhRegistrationHandler = this.pushAdapter.createNhRegistrationHandler(this.logger, extensionManager);

    app._requestHandler = this;

    // configure app level settings
    app.set('env', 'production');
    app.set('json spaces', 0);

    // common middleware components used by various routes
    var sharedMiddleware = {
        authenticate: authenticate(logSource, this.keys, this.userService),
        authorize: authorize(logSource, this.keys)
    };
    this._configureRoutes(app, sharedMiddleware);

    var apiMiddleware = [
        this._traceRequest.bind(this),
        sharedMiddleware.authenticate,
        sharedMiddleware.authorize
    ];
    this.apiBuilder = new ApiBuilder(app, apiMiddleware, this.scriptManager, this.logger, this.metrics);

    core.async.parallel([
        done => { self.scriptManager.initialize(done); },
        done => { self.apiBuilder.build(done); },
        done => { self.loginHandler.initialize(done); }
    ], done);
};

// configure the express app with all routes
RequestHandler.prototype._configureRoutes = function (app, sharedMiddleware) {
    var traceRequest = this._traceRequest.bind(this);

    // Configure common middleware run for all requests
    if (this.requireHttps === true) {
        app.use(requireHttpsMiddleware());
    }

    if (!this.skipVersionCheck) {
        app.use('/tables', versionCheck());
        app.use('/api', versionCheck());        
        app.use('/job', versionCheck());        
    }

    app.use(this._beginRequest.bind(this));
    app.use(requestLimit(this.maxRequestBodySize));
    app.use(express.bodyParser());
    app.use(express.methodOverride()); // Needed for IE8
    app.use(bodyParser()); // body parser handling application/xml, etc.
    app.use(express.timeout(this.requestTimeout));
    app.use(app.router);

    app.all('/:operation*', parseRequest);

    // OPTIONS preflight requests to support CORS - currently always returns 204
    app.options('*', optionsRequestHandler);

    // Parameter validators
    app.param('id', this._setRequestId.bind(this));
    app.param('table', this._validateTable.bind(this));
    app.param('job', this._validateJob.bind(this));

    // Table routes
    // Note: the middleware array is the set of middleware to run for each
    // matched route. These are called in a chain for each route.
    var middleware = [
        traceRequest,
        sharedMiddleware.authenticate,
        sharedMiddleware.authorize,
        validateQuery,
        bindHandler(this.tableHandler)
    ];

    app.post('/tables/:table', middleware); // for create
    app.post('/tables/:table/:id', middleware); // for undelete
    app.get('/tables/:table/:id?', middleware); // for read
    app.patch('/tables/:table/:id?', middleware); // for update
    app['delete']('/tables/:table/:id', middleware); // for delete
    app.all('/tables/:table', allowHandler('GET', 'POST'));
    app.all('/tables/:table/:id', allowHandler('GET', 'POST', 'PATCH', 'DELETE'));

    // Scheduler route
    middleware = [
        traceRequest,
        sharedMiddleware.authenticate,
        sharedMiddleware.authorize,
        bindHandler(this.schedulerHandler)
    ];
    app.post('/jobs/:job', middleware);
    app.all('/jobs/:job', allowHandler('POST'));

    // Status route
    middleware = [traceRequest, bindHandler(this.statusHandler)];
    app.get('/status', middleware);
    app.all('/status', allowHandler('GET'));

    // Diagnostics route
    middleware = [
        traceRequest,
        requireAuthorization('admin'),
        sharedMiddleware.authorize,
        bindHandler(this.diagnosticsHandler)
    ];
    app.get('/diagnostics', middleware);
    app.all('/diagnostics', allowHandler('GET'));

    // Login routes
    middleware = [traceRequest, bindHandler(this.loginHandler)];
    app.get('/login/:authenticationProvider', middleware);
    app.post('/login/:authenticationProvider?', middleware);
    app.all('/login/:authenticationProvider?', allowHandler('GET', 'POST'));

    // Crossdomain routes
    middleware = [traceRequest, bindHandler(this.crossDomainHandler)];
    app.get('/crossdomain/:crossDomainItem', middleware);
    app.all('/crossdomain/:crossDomainItem', allowHandler('GET'));

    // Push registration routes
    if (this.nhRegistrationHandler) {
        middleware = [
            this._setPushPermission.bind(this),
            traceRequest,
            sharedMiddleware.authenticate,
            sharedMiddleware.authorize,
            _.bind(this.nhRegistrationHandler.handlePost, this.nhRegistrationHandler)
        ];
        app.post('/push/registrationids', middleware);
        app.all('/push/registrationids', allowHandler('POST'));

        middleware = _.initial(middleware);
        middleware.push(_.bind(this.nhRegistrationHandler.handlePut, this.nhRegistrationHandler));
        app.put('/push/registrations/:id', middleware);

        middleware = _.initial(middleware);
        middleware.push(_.bind(this.nhRegistrationHandler.handleGet, this.nhRegistrationHandler));
        app.get('/push/registrations', middleware);

        middleware = _.initial(middleware);
        middleware.push(_.bind(this.nhRegistrationHandler.handleDelete, this.nhRegistrationHandler));
        app['delete']('/push/registrations/:id', middleware);
        app.all('/push/registrations/:id', allowHandler('PUT', 'DELETE', 'GET'));
    }

    // Finally, define a catch all handler that will be called
    // if no other routes were matched
    app.use(notFoundHandler);

    // Define the error handler that will be called in the case
    // of an unhandled error
    app.use(errorHandler(logSource));
};

// perform request initialization common to all handlers
RequestHandler.prototype._beginRequest = function (req, res, next) {
    var requestLogger = this._createRequestLogger();
    var self = this;

    // Create the requestContext and start a request latency timer
    req._context = {
        logger: requestLogger,
        corsHelper: this.corsHelper,
        metrics: this.metrics,
        latencyEvent: self.metrics.startEvent('request.latency.' + req.method),
        responseCallback: core.curry(writeResponse, requestLogger, req, res)
    };

    // remove the "powered by" header express adds to all
    // responses by default
    res.removeHeader("X-Powered-By");

    var installationID = req.headers['x-zumo-installation-id'];
    if (installationID) {
        this.metrics.logInstallation(installationID);
    }

    // If a content type has been specified for an http
    // method that we shouldn't be accepting content for,
    // flag the body as parsed, to prevent downstream body parsers
    // from attempting to parse. This is done for legacy reasons
    // (some client SDKs were sending content types when they
    // shouldn't have been, and we don't want to return 400s)
    var contentType = core.getContentType(req);
    if ((req.method == 'GET' || req.method == 'DELETE') && contentType !== null) {
        req._body = true;
    }

    // If no content type has been explicitly specified
    // and there is content, default to json (for legacy reasons)
    if (!contentType && req.headers['content-length'] > 0) {
        req.headers['content-type'] = 'application/json';
    }

    this._wrapResponse(req, res, requestLogger);

    requestLogger.startRequest(getRequestID(req));
    requestLogger.trace(logSource, _.sprintf("Request received: %s %s (Version: '%s')", req.method, req.url, version));

    next();
};

// intercept req.end to perform final actions on the request before
// it is completed.
RequestHandler.prototype._wrapResponse = function (req, res, logger) {
    var self = this;

    res.end = _.wrap(res.end, (oldEnd, data, encoding) => {
        if (!res.completed) {
            // a response was produced, so clear the timeout,
            // if a timeout has been applied to the request.
            if (req.clearTimeout) {
                req.clearTimeout();
            }

            addDefaultHeaders(req, res);

            var logEntry = _.sprintf('Request complete: StatusCode: %s', res.statusCode);
            logger.log(LogLevel.Verbose, LogType.Information, logSource, logEntry);

            self.metrics.endEvent(req._context.latencyEvent);
        }
        res.completed = true;

        oldEnd.call(res, data, encoding);
    });
};

RequestHandler.prototype._createRequestLogger = function () {
    var requestLogger = new Logger(LogLevel[this.logLevel]);
    return requestLogger;
};

function validateQuery(req, res, next) {
    var requestContext = req._context;
    var logger = requestContext.logger;
    var parsedRequest = requestContext.parsedRequest;

    try {
        Request.validateQuery(parsedRequest);
    }
    catch (e) {
        writeResponse(logger, req, res, e, null, StatusCodes.BAD_REQUEST);
        return;
    }

    next();
}

// Apply this middleware to a route to configure the required authorization
// level for that route. Must be applied BEFORE the authorize middleware.
function requireAuthorization(requiredLevel) {
    return (req, res, next) => {
        // set the required permission, which will be validated by the
        // authorize middleware
        req._context.parsedRequest.requiredPermission = requiredLevel;
        next();
    };
}

RequestHandler.prototype._setPushPermission = function (req, res, next) {
    req._context.parsedRequest.requiredPermission = this.extensionManager.getPushPermission(req);
    next();
};

RequestHandler.prototype._validateTable = function (req, res, next, tableName) {
    var requestContext = req._context;
    var responseCallback = requestContext.responseCallback;
    var parsedRequest = requestContext.parsedRequest;
    var dataModel = this.scriptManager.getDataModel();

    // verify that the table exists
    var table = dataModel.getTable(tableName);
    if (!table) {
        responseCallback(new core.MobileServiceError(
            _.sprintf("Table '%s' does not exist.", tableName)), null, StatusCodes.NOT_FOUND);
        return;
    }

    req.params.table = table.name;  // preserve casing

    var operation = core.verbToOperation(req.method);
    if (operation) {
        var requiredPermission = this.scriptManager.getTablePermission(tableName, operation);
        if (requiredPermission) {
            parsedRequest.requiredPermission = requiredPermission;
        }
    }

    next();
};

RequestHandler.prototype._validateJob = function (req, res, next, jobName) {
    var requestContext = req._context;
    var responseCallback = requestContext.responseCallback;
    var dataModel = this.scriptManager.getDataModel();

    // verify that job exists
    var job = dataModel.getJob(jobName);
    if (!job) {
        responseCallback(new core.MobileServiceError(
            _.sprintf("Job '%s' does not exist.", jobName)), null, StatusCodes.NOT_FOUND);
        return;
    }
    req.params.job = job.name;  // preserve casing

    // Default permission for jobs is 'user', to validate the required token.
    req._context.parsedRequest.requiredPermission = 'user';

    next();
};

RequestHandler.prototype._setRequestId = (req, res, next, id) => {
    req._context.parsedRequest.id = id;
    next();
};

// This method replaces all the console log methods with our implementations
// which log to user log.
RequestHandler.prototype.redirectConsole = function () {
    var self = this;

    // simplify the interface of logUser by defaulting the table, operation, etc.
    var logUser = function (logType) {
        var logArgs = Array.prototype.slice.call(arguments, 1);
        var message = util.format.apply(null, logArgs);
        var source = core.getUserScriptSource();

        if (!source) {
            // If not coming from user source, log directly to stdout.
            // This allows us to still insert console.logs in the fx code
            // for debugging, and also allows Mocha to work - without this
            // Mocha test output won't work!
            process.stdout.write(message + '\n');
        }
        else {
            self.metrics.event('api.console');
            self.logger.logUser(source, logType, message);
        }
    };

    console.log = core.curry(logUser, LogType.Information);
    console.info = core.curry(logUser, LogType.Information);
    console.warn = core.curry(logUser, LogType.Warning);
    console.error = core.curry(logUser, LogType.Error);
};

function parseRequest(req, res, next) {
    var requestContext = req._context;
    var logger = requestContext.logger;

    var parsedRequest;
    try {
        parsedRequest = Request.parse(req);
    }
    catch (e) {
        // if the request fails to parse for any reason,
        // its a bad request
        writeResponse(logger, req, res, e, null, StatusCodes.BAD_REQUEST);
        return;
    }

    if (parsedRequest) {
        requestContext.parsedRequest = parsedRequest;
        next();
    }
}

function getRequestID(req) {
    var requestID;
    if (req.headers) {
        // if there is an ARR request id in the headers, use it
        requestID = req.headers['x-arr-log-id'];
    }
    return requestID || uuid();
}

// returns the handle function of the specified handler,
// bound correctly for middleware use
function bindHandler(handler) {
    return _.bind(handler.handle, handler);
}

RequestHandler.prototype._traceRequest = function (req, res, next) {
    // we need to be careful not to log any sensitive request data
    // (e.g. actual body contents, authentication key values, etc.)
    var parsedRequest = req._context.parsedRequest;

    var logger = req._context.logger;

    var traceData = {
        verb: parsedRequest.verb,
        operation: parsedRequest.operation,
        target: req.params.table || req.params.job,
        query: parsedRequest.query,
        masterKeySpecified: !!parsedRequest.masterKey,
        applicationKeySpecified: !!parsedRequest.applicationKey,
        authenticationKeySpecified: !!parsedRequest.authenticationKey
    };

    if (this.newRelicAdapter) {
        this.newRelicAdapter.nameTransaction(traceData);
    }

    logger.trace(logSource, 'Processing request: ' + util.inspect(traceData));

    next();
};

// This is the default response method used for table operations and other operations
// where user script doesn't interact directly with the response (res.send, etc.). It is
// also used for all internally produced responses (e.g. error responses).
function writeResponse(logger, req, res, error, result, statusCode, additionalHeaders) {
    additionalHeaders = additionalHeaders || {};

    // Currently our responses are always JSON or HTML. So if it's not explicitly HTML,
    // we will JSON-serialize it.
    var responseIsJson = additionalHeaders['content-type'] !== 'text/html';

    // Prevent attempts to write to the response more than once.
    // This can happen in certain situations, for example if we've
    // ended a request due to timeout, but the request is still being
    // processed and tries to write to the response later.
    if (res.completed) {
        return;
    }

    if (result !== null && result !== undefined && responseIsJson) {
        // check for a __version property to use to get the etag header value
        if (result.__version) {
            var etag = core.stringify(result.__version);
            // if this was a get with a if-none-match header
            // the client may alrady have the latest version so
            // we send a 304 and no body instead of the result
            if (req.method.toLowerCase() === 'get' && EtagHelper.doesIfNoneMatchHeaderMatchesEtag(req.headers['if-none-match'], etag)) {
                result = null;
                statusCode = StatusCodes.NOT_MODIFIED;
            }
            else {
                additionalHeaders.ETag = etag;
            }
        }

        // verify that the result (which may include user provided
        // content) can be serialized correctly (e.g. no circular
        // references, etc.)
        if (result !== null) {
            try {
                result = core.stringify(result);
            }
            catch (e) {
                // if the response fails to serialize for whatever reason,
                // write to user log
                if (logger) {
                    logger.logUser('', LogType.Error, e.toString());
                }
                error = ErrorHelper.createInternalServerError();
            }
        }
    }

    if (error) {
        // we only want to include the request ID in the response if log
        // entries were actually written for that request
        var requestID = (logger && logger.requestEntriesWritten) ? logger.requestID : null;

        // Merge conflicts require special error handling, because the
        // result is the server version of the item and not an error message.
        if ((error.isMergeConflict || error.isConflict) && error.item) {
            statusCode = error.isMergeConflict ? StatusCodes.PRECONDITION_FAILED : StatusCodes.CONFLICT;
            result = core.stringify(error.item);
            if (error.item && error.item.__version) {
                additionalHeaders.ETag = core.stringify(error.item.__version);
            }
        }
        else {
            result = ErrorHelper.formatError(error, statusCode, requestID);
            statusCode = result.code;
            result = core.stringify(result);
        }
    }

    // ensure that we have a valid status code
    statusCode = statusCode || StatusCodes.INTERNAL_SERVER_ERROR;
    res.statusCode = statusCode;

    // set any additional headers before calling end
    // note that end will add additional headers before
    // completing the request
    res.set(additionalHeaders);
    if (result) {
        // json response is utf-8 by default
        res.set('Content-Length', Buffer.byteLength(result, 'utf8'));
    }

    if (result !== null) {
        res.end(result);
    }
    else {
        res.end();
    }
}

// set the standard Zumo headers on the response
function addDefaultHeaders(req, res) {
    var requestContext = req._context;

    res.set('x-zumo-version', version);
    res.set('x-zumo-server-version', 'nodev1-' + npmPackageVersion);

    setHeaderIfNotSet(res, 'content-type', 'application/json');
    setHeaderIfNotSet(res, 'cache-control', 'no-cache');

    var corsHeaders = requestContext.corsHelper.getCorsHeaders(req);
    for (var header in corsHeaders) {
        setHeaderIfNotSet(res, header, corsHeaders[header]);
    }
}

// set the specified header IFF it is not already set,
// allowing for overrides
function setHeaderIfNotSet(res, header, value) {
    if (!res.get(header)) {
        res.set(header, value);
    }
}

function notFoundHandler(req, res) {
    writeResponse(req._context.logger, req, res, new core.MobileServiceError('Not Found'), null, StatusCodes.NOT_FOUND);
}

function optionsRequestHandler(req, res) {
    writeResponse(req._context.logger, req, res, null, null, StatusCodes.NO_CONTENT);
}