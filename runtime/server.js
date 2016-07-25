// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module creates and initializes the HTTP server

var path = require('path'),
    NewRelicAdapter = require('./newrelicadapter'),
    core = require('./core');

// If the customer has turned on New Relic we need to load this before anything else
// so it can hook itself into the appropriate modules
var newRelicAdapter = new NewRelicAdapter();
newRelicAdapter.initialize(resolveConfigPath(process.env, __dirname));

var RequestHandler = require('./request/requesthandler'),
    FileWatcher = require('./filewatcher'),
    net = require('net'),
    Request = require('./request/request'),
    Logger = require('./logger'),
    StatusCodes = require('./statuscodes').StatusCodes,
    core = require('./core'),
    tripwire = require('tripwire'),
    Metrics = require('./metrics'),
    ScriptManager = require('./script/scriptmanager'),
    ExtensionManager = require('./script/extensionmanager'),
    Storage = require('./storage/Storage'),
    UserService = require('./users/userservice'),
    resource = require('./resources'),
    _ = require('underscore'),
    _str = require('underscore.string'),
    express = require('express'),
    PushAdapter = require('./push/pushadapter'),
    util = require('util');

_.mixin(_str.exports());

var logSource = 'Server';

exports = module.exports = Server;

function Server(env, options) {
    core.ensureParamNotNull(env, 'env');

    options = options || {};
    this._usingSiteExtension = usingSiteExtension(env);
    this._runtimeVersion = this._usingSiteExtension ? env.MOBILESERVICESNODE_EXTENSION_VERSION : env.runtimeVersion;
    this._app = express();
    this.net = net; // for test mocking

    // read env settings and promote to members
    this._enabledBetaFeatures = core.parseCsvSetting(env.MS_EnabledBetaFeatures);
    this._sentinelFilePollInterval = parseInt(env.MS_SentinelFilePollInterval, 10) || 5000;
    this._processShutdownTimeout = parseInt(env.MS_ProcessShutdownTimeout, 10) || 2000;
    this._metricsFlushTimeout = parseInt(env.MS_MetricsTimeout, 10) || 300000;
    this._iisNodeControlPipe = env.IISNODE_CONTROL_PIPE;
    this._homePath = env.HOME;

    this._initializeLogging(env, options);
    this._globalLogger.log(LogLevel.Verbose, LogType.Information, logSource, "Starting server ...");

    try {
        this._createAndInitializeServices(env);
        this._registerUncaughtExceptionListenerAndCreateHttpServer(env, this._globalLogger);
    }
    catch (err) {
        this._globalLogger.error(logSource, err);
        throw err;
    }
}

Server.usingSiteExtension = usingSiteExtension;
Server.resolveConfigPath = resolveConfigPath;
Server.newRelicAdapter = newRelicAdapter;
Server.getAuthenticationCredentials = getAuthenticationCredentials;

Server.prototype.listen = function () {
    this._server.listen.apply(this._server, arguments);
};

Server.prototype._initializeLogging = function (env, options) {
    var self = this;

    Logger.initialize(env.MS_LogServiceURL, env.MS_LogServiceToken, core.parseBoolean(env.MS_LoggingServiceDisabled));

    this._globalLogger = options.logger || new Logger(LogLevel[env.MS_LogLevel]);

    Logger.writer.on('error', function (err) {
        // we need this handler here to prevent errors
        // from bubbling up to the global exception handler, which would
        // cause the process to be killed

        // If the log writer throws an error, it won't necessarily be safe to try to log it (could cause infinite loop), so only attempt to log if indicated.
        if (err && err.writeToSystemLogs && self._globalLogger !== null) {
            self._globalLogger.error('logwriter', err);
        }
    });
};

Server.prototype._createAndInitializeServices = function (env) {
    var maxRequestBodySize = (env.MS_MaxRequestBodySizeKB || 1024) * 1024,
        authenticationCredentials = getAuthenticationCredentials(env),
        crossDomainWhitelist = parseJsonSetting(env.MS_CrossDomainWhitelist, this._globalLogger),
        previewFeatures = parseJsonSetting(env.MS_PreviewFeatures, this._globalLogger),
        configPath = resolveConfigPath(env, __dirname);

    this._metrics = new Metrics(this._globalLogger, this._metricsFlushTimeout); // Five minutes default

    newRelicAdapter.complete(this._globalLogger, this._metrics);

    this._userService = UserService.create(env, previewFeatures, this._metrics, this._globalLogger);
    this._pushAdapter = new PushAdapter(configPath, env, authenticationCredentials);
    this._storage = new Storage(env.MS_SqlConnectionString, env.MS_MobileServiceName, core.parseBoolean(env.MS_DynamicSchemaEnabled), this._globalLogger, this._metrics);
    this._scriptManager = new ScriptManager(configPath, this._storage, this._globalLogger, this._metrics, this._pushAdapter);
    this._requestHandler = new RequestHandler(configPath, env.MS_MasterKey, env.MS_ApplicationSystemKey, env.MS_MobileServiceName, authenticationCredentials, crossDomainWhitelist, env.MS_ApplicationKey, this._runtimeVersion, env.requestTimeout, this._storage, this._scriptManager, this._globalLogger, this._metrics, env.MS_LogLevel, env.MS_LogServiceURL, env.MS_LogServiceToken, maxRequestBodySize, newRelicAdapter, this._userService, this._pushAdapter, env.MS_MobileServiceDomainSuffix, env.MS_RequireHttps, !!env.MS_SkipVersionCheck);
    this._extensionManager = new ExtensionManager(this._app, this._scriptManager, this._globalLogger, this._metrics, configPath);

    // Ensure any calls to console are redirected to the log
    this._requestHandler.redirectConsole();
};

Server.prototype._createHttpServer = function (env) {
    var server,
        self = this;

    if (env.pfx) {
        server = require('https').createServer({ pfx: env.pfx, passphrase: env.passphrase }, this._app);
    }
    else {
        server = require('http').createServer(this._app);
    }

    // override the listen function so the server only starts listening
    // once all async initialization is complete
    var originalListen = server.listen;
    server.listen = function () {
        var listenArgs = arguments;

        var asyncStartupFunctions = [
            function (done) { self._extensionManager.initialize(done); },
            function (done) { self._requestHandler.initialize(self._app, self._extensionManager, done); }
        ];

        if (!self._pushAdapter.notificationHubPush) {
            asyncStartupFunctions.push(function (done) {
                self._scriptManager.runFeedbackScript(3600000);
                done();
            });
        }

        asyncStartupFunctions.push(function (done) { self._extensionManager.runStartupScript(done); });

        core.async.series(asyncStartupFunctions, function () {
            originalListen.apply(server, listenArgs);
            self._setupFileWatcher();
            self._globalLogger.log(LogLevel.Verbose, LogType.Information, logSource, "Server started and listening.");
        });
    };

    return server;
};

// Set up our filewatcher on the sentinel file
Server.prototype._setupFileWatcher = function () {
    var self = this;

    var sentinelFilePath = path.join(this._homePath, 'site/wwwroot/sentinel');
    this._fileWatcher = new FileWatcher(sentinelFilePath, self._globalLogger, this._sentinelFilePollInterval, function () {
        self._fileWatcher.stop();
        self._triggerRecycle();
    });

    this._server.on('listening', function () {
        self._fileWatcher.start();
    });
};

Server.prototype._triggerRecycle = function () {
    var self = this;

    if (this._iisNodeControlPipe) {
        // When running as a site extension, the recycleSignalEnabled IIS Node
        // option is enabled and env.IISNODE_CONTROL_PIPE will contain the
        // control channel IIS Node has established for us to communicate back.
        // We send the 'recycle' event to force it to gracefully recycle
        // us. When this happens, the current process will be allowed
        // to process any outstanding requests, but new requests will
        // be routed by IIS Node to new instances.
        var stream = this.net.connect(this._iisNodeControlPipe);
        stream.on('error', function (err) {
            // if we get a stream error, we fall back to a
            // "hard shutdown" after logging the error
            self._shutdownProcess(0);
        });
        stream.write('recycle');
        stream.end();
    }
    else {
        // This codepath will only be hit in test environments,
        // e.g., when running the server outside of IIS Node
        this._server.close();
        this._shutdownProcess(0);
    }
};

Server.prototype._registerUncaughtExceptionListenerAndCreateHttpServer = function (env, logger) {
    var tripwireContext = {},
        tripwireKeepalive = parseInt(env.MS_TripwireKeepalive, 10) || 5000,
        self = this;

    // 99.9% of the time async errors will end up here and we assume all async errors belong to user code
    this._onUncaughtException = function (e) {
        process.removeAllListeners('uncaughtException');

        var exitCode;
        var isTripWireError = false;
        if (tripwireContext === tripwire.getContext()) {
            e = new Error(_.sprintf(resource.tripwireError, tripwireKeepalive));
            exitCode = 2;
            isTripWireError = true;
        } else {
            e = e || new Error('The application generated an unspecified exception.');
            exitCode = 1;
        }

        self._logGlobalException(e, isTripWireError, logger);

        self._shutdownProcess(exitCode);
    };

    process.on('uncaughtException', this._onUncaughtException);

    this._app.server = this._server = this._createHttpServer(env);

    function resetTripwire() {
        tripwire.resetTripwire(tripwireKeepalive * 2, tripwireContext);
    }

    resetTripwire();
    this._tripwireInterval = setInterval(resetTripwire, tripwireKeepalive);

    this._server.on('close', this._unregisterTripwireAndExceptionHandler.bind(this));
};

Server.prototype._unregisterTripwireAndExceptionHandler = function () {
    tripwire.clearTripwire();
    clearInterval(this._tripwireInterval);
    process.removeListener('uncaughtException', this._onUncaughtException);
};

Server.prototype._shutdownProcess = function (exitCode, timeout) {
    timeout = timeout || this._processShutdownTimeout;

    // flush any pending global log operations
    Logger.flush();

    // Wait a short period of time to allow any other logger instances a chance
    // to flush themselves (based on their flush timeouts).
    setTimeout(function () {
        process.exit(exitCode);
    }, timeout);
};

Server.prototype._logGlobalException = function (e, isTripWireError, logger) {
    if (e.loggedToSystem || e.loggedToUser) {
        // we've already logged this error
        return;
    }

    if (!isTripWireError && core.isRuntimeError(e)) {
        logger.error(logSource, e);
    } else {
        logger.logUserUnhandled(e);
    }
};

function getAuthenticationCredentials(env) {
    // If web.config/env var entries do not exist, auth settings default to undefined
    var result = {
        microsoftaccount: {
            clientId: env.MS_MicrosoftClientID,
            clientSecret: env.MS_MicrosoftClientSecret,
            packageSid: env.MS_MicrosoftPackageSID,
            scope: env.MS_MicrosoftScope,
            display: env.MS_MicrosoftDisplay
        },
        facebook: {
            appId: env.MS_FacebookAppID,
            appSecret: env.MS_FacebookAppSecret,
            scope: env.MS_FacebookScope,
            display: env.MS_FacebookDisplay
        },
        twitter: {
            consumerKey: env.MS_TwitterConsumerKey,
            consumerSecret: env.MS_TwitterConsumerSecret
        },
        google: {
            clientId: env.MS_GoogleClientID,
            clientSecret: env.MS_GoogleClientSecret,
            gcmApiKey: env.MS_GcmApiKey,
            scope: env.MS_GoogleScope,
            accessType: env.MS_GoogleAccessType
        },
        aad: {
            clientId: env.MS_AadClientID,
            tenants: env.MS_AadTenants ? core.parseCsvSetting(env.MS_AadTenants) : null
        }
    };

    result.microsoftaccount.enabled = isProviderEnabled(result.microsoftaccount.clientId, result.microsoftaccount.clientSecret);
    result.facebook.enabled = isProviderEnabled(result.facebook.appId, result.facebook.appSecret);
    result.twitter.enabled = isProviderEnabled(result.twitter.consumerKey, result.twitter.consumerSecret);
    result.google.enabled = isProviderEnabled(result.google.clientId, result.google.clientSecret);
    result.aad.enabled = settingHasValue(result.aad.clientId);

    return result;

    // a certain auth credential provider is enabled if all required fields are non empty strings
    function isProviderEnabled(id, secret) {
        return settingHasValue(id) && settingHasValue(secret);
    }

    function settingHasValue(setting) {
        if (!core.isString(setting) || _.isBlank(setting)) {
            return false;
        }
        return true;
    }
}

function parseJsonSetting(option, logger) {
    if (option) {
        try {
            return JSON.parse(option);
        } catch (ex) {
            ex.message += "; Attempted JSON value: " + option;
            logger.error(logSource, ex);
        }
    }

    return null;
}

function usingSiteExtension(env) {
    return typeof env.MOBILESERVICESNODE_EXTENSION_VERSION === 'string' &&
           env.MOBILESERVICESNODE_EXTENSION_VERSION.length > 0;
}

// Determine the config path conditionally, depending on whether we're
// running as a site extension
function resolveConfigPath(env, currentDir) {
    var configPath;

    if (usingSiteExtension(env)) {
        configPath = path.join(env.HOME, 'site', 'wwwroot');
    } else {
        configPath = path.join(currentDir, '..', env.dataDirectory || './App_Data', 'config');
    }

    return configPath;
}
