// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// Wraps a script cache and provides funcionality for loading scripts into the cache

var fs = require('fs');

var path = require('path');
var ScriptCache = require('./scriptcache');
var StatusCodes = require('../statuscodes');
var fileHelpers = require('../filehelpers');
var _ = require('underscore');
var _str = require('underscore.string');
var core = require('../core');
var Metadata = require('./metadata');

_.mixin(_str.exports());

exports = module.exports = ScriptLoader;

var logSource = 'ScriptLoader';
var dataModelFileName = 'datamodel.json';

function ScriptLoader(configPath, cache, logger) {
    this.configPath = configPath;
    this.scriptRoot = path.join(configPath, core.getScriptsDirName(configPath));
    this.cache = cache || new ScriptCache();
    this.logger = logger;
    this.maxFileOperationRetries = 3;
    this.fileOperationRetryIntervalMS = 500;
}

ScriptLoader.prototype.load = function (done) {
    var self = this;

    // only after we've loaded all directories do we complete
    core.async.series([
        done => { self._loadDataModel(done); },
        done => {
            core.async.parallel([
                done => { self._loadTablesDirectory(done); },
                done => { self._loadJobsDirectory(done); },
                done => { self.loadScriptDirectory('shared', null, done); }                
            ], () => {                
                if (done) {
                    done();
                }
            });
        }
    ], done);
};

// load all scripts for the specified script type
ScriptLoader.prototype.loadScriptDirectory = function (scriptType, options, done) {
    var self = this;

    // determine the filepath based on the script type
    // Note that 'config' is a special case - for that root
    // dir, we're only concerned with the datamodel.json file
    var filepath;
    if (scriptType === 'config') {
        filepath = this.configPath;
    }
    else {
        filepath = path.join(this.scriptRoot, scriptType);
    }

    this.logger.trace(logSource, _.sprintf("Loading scripts directory '%s'", filepath));

    fs.readdir(filepath, (err, files) => {
        if (err) {
            if (options && core.isFunction(options.error)) {
                options.error(err);
                return;
            }
            // fatal - this will go to the global handler
            throw err;
        }

        var scriptsLoaded = 0;
        var numScriptsToLoad = files.length;
        var loadCallbackCount = 0;

        function loadComplete() {
            self.logger.trace(logSource, _.sprintf("%d %s script(s) loaded", scriptsLoaded, scriptType));
            if (done) {
                done();
            }
        }

        // callback to call after a script has been loaded
        function completeLoad(err, scriptInfo) {
            if (err) {
                if (core.isFunction(options.error)) {
                    options.error(err, scriptInfo);
                }
                else {
                    throw err;
                }
            }
            var scriptLoaded = scriptInfo && (scriptInfo.script || scriptInfo.module);
            if (scriptLoaded) {
                scriptsLoaded++;

                if (options && options.load) {
                    options.load(scriptInfo);
                }
            }

            if (++loadCallbackCount === numScriptsToLoad) {
                loadComplete();
            }
        }

        if (numScriptsToLoad === 0) {
            loadComplete();
        }
        else {
            files.forEach(file => {
                self._loadScript(scriptType, filepath, file, options, completeLoad);
            });
        }
    });
};

ScriptLoader.prototype.getDataModel = function () {
    var key = this.cache.getKey('config', dataModelFileName);
    var dataModelEntry = this.cache.get(key);

    if (!dataModelEntry) {
        // since the datamodel file is loaded on startup, and the
        // app doesn't serve requests until it has been loaded, if
        // the file isn't in cache it indicates a problem.
        throw new core.MobileServiceError('DataModel file has not been loaded');
    }

    return dataModelEntry.module;
};

ScriptLoader.prototype.getMetadata = function (scriptType, rootFileName) {
    var metadataFileName = rootFileName + '.json';
    var key = this.cache.getKey(scriptType, metadataFileName);
    var metadataEntry = this.cache.get(key);

    if (metadataEntry && metadataEntry.module) {
        return metadataEntry.module;
    }

    return null;
};

ScriptLoader.prototype._loadScript = function (scriptType, filepath, filename, options, callback) {
    if (!isScriptFile(filename)) {
        callback(null);
        return;
    }

    var filter = options ? options.filter : null;
    if (filter && !filter(filename)) {
        callback(null);
        return;
    }

    this.logger.trace(logSource, _.sprintf("Loading '%s' into the script cache", filename));

    var self = this;
    var scriptPath = path.join(filepath, filename);
    var scriptInfo = getScriptInfo(filepath, filename);
    var key = self.cache.getKey(scriptType, filename);

    function completeLoad(err) {
        if (!err) {
            self.cache.set(key, scriptInfo);
            callback(null, scriptInfo);
        }
        else {
            callback(err, scriptInfo);
        }
    }

    if (isModule(scriptType, filepath, filename)) {
        // first clear any existing require cache entry then load/reload
        delete require.cache[scriptPath];
        fileHelpers.requireWithRetries(scriptPath, this.logger, (err, loadedModule) => {
            if (!err) {
                if (isMetadataFile(filename)) {
                    try {
                        // transform the raw module data into a Metadata object
                        scriptInfo.module = new Metadata(loadedModule, filename);
                    }
                    catch (e) {
                        // if the metadata is invalid, we need to log to user log
                        handleScriptLoadError(e, scriptInfo);
                        return;
                    }
                }
                else {
                    scriptInfo.module = loadedModule;
                }
                completeLoad();
            }
            else {
                handleScriptLoadError(err, scriptInfo);
            }
        }, this.maxFileOperationRetries, this.fileOperationRetryIntervalMS);
    }
    else {
        fileHelpers.readFileWithRetries(scriptPath, this.logger, (err, script) => {
            if (!err) {
                scriptInfo.script = script;
                completeLoad();
            }
            else {
                handleScriptLoadError(err);
            }
        }, this.maxFileOperationRetries, this.fileOperationRetryIntervalMS);
    }

    function handleScriptLoadError(err, scriptInfo) {
        ScriptLoader.logScriptLoadError(self.logger, err, scriptType, filename);
        completeLoad(err, scriptInfo);
    }
};

ScriptLoader.logScriptLoadError = (logger, err, scriptType, fileName) => {
    var source = _.sprintf('/%s/%s', scriptType, fileName);
    logger.logUser(source, LogType.Error, _.sprintf("Failed to load script file '%s': %s", fileName, core.sanitizeUserCallStack(err)));
};

ScriptLoader.prototype.getTableScript = function (table, operation) {
    if (typeof table !== 'string' || table.length === 0) {
        throw new Error('Table must be a non-empty string');
    }

    if (typeof operation !== 'string' || operation.length === 0) {
        throw new Error('Operation must be a non-empty string');
    }

    var key = this.cache.getKey('table', _.sprintf("%s.%s.js", table, operation));
    var scriptInfo = this.cache.get(key);

    if (!scriptInfo || !scriptInfo.script || scriptInfo.script.length === 0) {
        return null;
    }

    return scriptInfo.script;
};

ScriptLoader.prototype.getScript = function (scriptType, name) {
    name = name.toLowerCase();
    if (!_.endsWith(name, '.js')) {
        name = name + '.js';
    }

    var key = this.cache.getKey(scriptType, name);
    var scriptInfo = this.cache.get(key);

    return scriptInfo ? scriptInfo.script : null;
};

ScriptLoader.prototype._removeScript = function (scriptType, filename) {
    if (isScriptFile(filename)) {
        this.logger.trace(logSource, _.sprintf("Removing '%s' from the script cache", filename));
        var key = this.cache.getKey(scriptType, filename);
        this.cache.remove(key);
    }
};

ScriptLoader.prototype._loadTablesDirectory = function (done) {
    var dataModel = this.getDataModel();
    var dataModelIsValid = dataModel && dataModel.tables && Array.isArray(dataModel.tables);

    this.loadScriptDirectory('table', {
        load(scriptInfo) {
            if (dataModelIsValid && 
                isMetadataFile(scriptInfo.scriptFileName) && // and this is a json file for a table 
                !dataModel.getTable(scriptInfo.name)) { // and table is not already added                        

                var entry = { name: scriptInfo.name };
                dataModel.tables.push(entry);
                dataModel._tableMap[entry.name.toLowerCase()] = entry;
            }
        }
    }, done);
};

ScriptLoader.prototype._loadJobsDirectory = function (done) {
    var dataModel = this.getDataModel();
    var dataModelIsValid = dataModel && dataModel.jobs && Array.isArray(dataModel.jobs);

    this.loadScriptDirectory('scheduler', {
        load(scriptInfo) {
            if (dataModelIsValid && 
                path.extname(scriptInfo.scriptFileName).toLowerCase() === '.js' && // and this is a script file for a job
                !dataModel.getJob(scriptInfo.name)) { // and job is not already added                        

                var entry = { name: scriptInfo.name };
                dataModel.jobs.push(entry);
                dataModel._jobMap[entry.name.toLowerCase()] = entry;
            }
        }
    }, done);
};

ScriptLoader.prototype._loadDataModel = function (done) {
    var options = {
        filter(filename) {
            // in the root config dir, we only load the single
            // datamodel.json file
            return filename.toLowerCase() === dataModelFileName;
        },
        load(scriptInfo) {
            configureDataModel(scriptInfo.module);
        }
    };

    this.loadScriptDirectory('config', options, done);
};

// extend the raw dataModel module by adding helper functions
function configureDataModel(dataModel) {
    var tableMap = dataModel._tableMap = {};
    var jobMap = dataModel._jobMap = {};

    function nameSelector(item) {
        return item.name.toLowerCase();
    }

    // build lookup objects for tables/jobs by name
    if (dataModel.tables) {
        core.toLookup(dataModel.tables, tableMap, nameSelector);
    }
    if (dataModel.jobs) {
        core.toLookup(dataModel.jobs, jobMap, nameSelector);
    }

    dataModel.getTable = tableName => tableMap[tableName.toLowerCase()];

    dataModel.getJob = jobName => jobMap[jobName.toLowerCase()];
}

// returns true if the specified file is a js or json file
function isScriptFile(filename) {
    var ext = path.extname(filename).toLowerCase();
    return ext === '.js' || ext === '.json';
}

// create and return a script cache entry for the specified script
function getScriptInfo(scriptPath, filename) {
    var scriptInfo = {
        name: fileHelpers.removeExtension(filename),
        scriptFileName: filename,
        scriptPath: path.join(scriptPath, filename)
    };

    return scriptInfo;
}

// returns true if the specified script should be loaded as a node module,
// or whether it's script source should be loaded as text
function isModule(scriptType, filepath, filename) {
    if (!isScriptFile(filename)) {
        return false;
    }

    // TODO: For now we only do module loading for api scripts and json metadata files.
    // Once we support v2 style table/job/etc scripts, this will need to be updated for
    // those script types
    var ext = path.extname(filename).toLowerCase();
    return (ext === '.json' || scriptType === 'api' || scriptType === 'extensions');
}

function isMetadataFile(filename) {
    var ext = path.extname(filename).toLowerCase();
    return ext === '.json' && filename !== dataModelFileName;
}
