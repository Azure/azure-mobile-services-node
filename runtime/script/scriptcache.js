// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// Caches scripts based on key.

exports = module.exports = ScriptCache;

function ScriptCache() {
    this.cache = {};
}

ScriptCache.prototype.set = function (key, scriptInfo) {
    this.cache[key.toLowerCase()] = scriptInfo;
};

ScriptCache.prototype.remove = function (key) {
    delete this.cache[key.toLowerCase()];
};

ScriptCache.prototype.get = function (key) {
    return this.cache[key.toLowerCase()];
};

ScriptCache.prototype.getKey = (scriptType, filename) => // important to retain the filename extension to ensure uniqueness
scriptType + '-' + filename;
