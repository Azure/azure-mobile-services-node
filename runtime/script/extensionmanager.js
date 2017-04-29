// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is responsible for loading and running extension scripts

var path = require('path');

var fs = require('fs');
var core = require('../core');
var _ = require('underscore');
var _str = require('underscore.string');

_.mixin(_str.exports());

exports = module.exports = ExtensionManager;

var logSource = 'ExtensionManager';
var extensionsDirectory = 'extensions';
var startupFileName = 'startup.js';
var pushFileName = 'push.js';

ExtensionManager.pushMetadataFileName = 'push.json';

function ExtensionManager(app, scriptManager, logger, metrics, configPath) {
    this.app = app;
    this.scriptManager = scriptManager;
    this.logger = logger;
    this.metrics = metrics;
    this.configPath = configPath;
    this.extensions = {};
    this.scriptRunTimeout = 5000;
    this.allExtensions = [startupFileName, pushFileName, ExtensionManager.pushMetadataFileName];
    this.pushScriptLoaderName = ExtensionManager.pushMetadataFileName.replace('.json', '');
}

ExtensionManager.prototype.initialize = function (done) {
    var self = this;

    if (!this._extensionsFolderExists()) {
        done();
        return;
    }

    var options = {
        load: this._onScriptLoad.bind(this),
        error(err) {
            self.logger.logUser(logSource, LogType.Error, err.toString());
            done();
        }
    };

    this.scriptManager.scriptLoader.loadScriptDirectory(extensionsDirectory, options, done);
};

ExtensionManager.prototype.runPushRegistrationScript = function (registration, user, done) {
    var options = {
        swallowError: false,
        args: registration,
        extraContext: { user }
    };

    this.runExtensionScript(pushFileName, 'register', options, done);
};

ExtensionManager.prototype.runStartupScript = function (done) {
    var options = {
        swallowError: true,
        scriptTimeout: this.scriptRunTimeout,
        extraContext: { app: this.app }
    };

    this.runExtensionScript(startupFileName, 'startup', options, done);
};

ExtensionManager.prototype.runExtensionScript = function (scriptName, scriptMethodName, options, done) {
    var scriptModule = this._getExtension(scriptName);
    if (scriptModule) {
        var source = path.join('/', extensionsDirectory, scriptName);
        var serviceOptions = {};

        if (options && !options.swallowError) {
            serviceOptions.responseCallback = done;
        }

        var context = this.scriptManager.buildScriptService(source, this.logger, serviceOptions);

        if (options && options.extraContext) {
            _.extend(context, options.extraContext);
        }

        this._callExtension(scriptModule.name, scriptModule.module, scriptMethodName, options, context, done);
    }
    else {
        done();
    }
};

ExtensionManager.prototype.getPushPermission = function (req) {
    if (this._getExtension(ExtensionManager.pushMetadataFileName)) {
        // Remove '/push' from the start of the route
        var subRoute = req.route.path.substring(5);
        var permission = this.scriptManager.getRoutePermission(extensionsDirectory, this.pushScriptLoaderName, subRoute, req.method);

        if (permission) {
            return permission;
        }
    }

    // default to application security if route is not found
    return 'application';
};

ExtensionManager.prototype._extensionsFolderExists = function () {
    var extensionsPath = path.join(this.configPath, core.getScriptsDirName(this.configPath), extensionsDirectory);
    return fs.existsSync(extensionsPath);
};

ExtensionManager.prototype._getExtension = function (name) {
    var extension = this.extensions[name];
    return extension;
};

ExtensionManager.prototype._callExtension = function (name, module, method, options, context, done) {
    var self = this;
    var doneCalled = false;

    var fn = module[method];
    if (!core.isFunction(fn)) {
        this.logger.logUser(logSource, LogType.Warning, _.sprintf('Skipping execution of method \'%s\' on extension \'%s\' as it does not export the method.', method, name));
        done();
        return;
    }

    var nameWithoutExtension = path.basename(name, '.js');
    this.metrics.event('api.extension.' + nameWithoutExtension + '.' + method);

    try {
        var extensionArgs = [];

        if (options && options.args) {
            if (_.isArray(options.args)) {
                extensionArgs = extensionArgs.concat(options.args);
            } else {
                extensionArgs.push(options.args);
            }
        }

        extensionArgs.push(context);

        if (options && _.isNumber(options.scriptTimeout)) {
            var callbackWrapper = error => {
                if (!doneCalled) {
                    doneCalled = true;
                    if (options && !options.swallowError) {
                        done(error);
                    } else {
                        done();
                    }
                }
            };

            extensionArgs.push(callbackWrapper);
        } else {
            extensionArgs.push(done);
        }

        fn(...extensionArgs);
    } catch (e) {
        this.logger.logUser(logSource, LogType.Error, _.sprintf('Failed to execute \'%s\' of %s due to error: %s', method, name, e.toString()));
        if (options && !options.swallowError) {
            throw new core.MobileServiceError(e, core.ErrorCodes.ScriptError);
        }
    }

    if (options && _.isNumber(options.scriptTimeout)) {
        // if module fails to call 'done' with in time limit then we call it ourself to resume execution
        setTimeout(() => {
            if (!doneCalled) {
                doneCalled = true;
                var errorMessage = _.sprintf('\'%s\' of \'%s\' failed to call \'done\' method with in %d ms', method, name, options.scriptTimeout);
                self.logger.logUser(logSource, LogType.Error, errorMessage);
                if (options && !options.swallowError) {
                    done(new core.MobileServiceError(errorMessage, core.ErrorCodes.ScriptError));
                } else {
                    done();
                }
            }
        }, options.scriptTimeout);
    }
};

ExtensionManager.prototype._onScriptLoad = function (scriptInfo) {
    var fileName = scriptInfo.scriptFileName.toLowerCase();
    var isScript = isScriptFile(fileName);

    if (!isScript || !_.contains(this.allExtensions, fileName)) {
        return;
    }

    this.extensions[fileName] = {
        name: fileName,
        module: scriptInfo.module
    };
};

function isScriptFile(fileName) {
    var extension = path.extname(fileName);
    return extension === '.js' || extension === '.json';
}