// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This is a module that has logic related to creating user object and getting its identities

var _ = require('underscore'),
    _str = require('underscore.string'),
    ZumoCallback = require('../script/zumocallback'),
    UserService = require('../users/userservice');

_.mixin(_str.exports());

exports = module.exports;

var logSource = 'User';

// create user object from request attributes
// requestContext is an object with following structure
// {
//    parsedRequest: {}
//    metrics: {}
//    logger: {}
// }
exports.create = function (requestContext, keys, userService) {
    userService = userService || UserService.nullService;

    var request = requestContext.parsedRequest;
    var token = request.authenticationToken;

    var user = {};
    user.level = _getLevel(request, keys);

    user.userId = token && token.claims && token.claims.uid ? token.claims.uid : request.userId;
    if (token && token.claims && token.claims.id) {
        user.id = token.claims.id;
    }

    var getIdentities = new GetIdentitiesHelper(requestContext, token, userService);
    user.getIdentities = getIdentities.invoke.bind(getIdentities);

    return user;
};

// getIdentites method can be called in 3 ways
// 1) var identities = user.getIdentities() // this is the synchronous version (will be deprecated eventually)
// 2) user.getIdentities(function(err, identities){..}) // this is the deprecated async version
// 3) user.getIdentities({success: function(identities){..}, error: function(error){...}}) // this the async version with callback options
function GetIdentitiesHelper(requestContext, token, userService) {
    this.requestContext = requestContext;
    this.token = token;
    this.userService = userService;
}

GetIdentitiesHelper.prototype.invoke = function (callbackOrOptions) {
    var script = this.requestContext.script || '',
        metrics = this.requestContext.metrics,
        logger = this.requestContext.logger;

    if (!callbackOrOptions) {
        metrics.event('api.user.getIdentities');
        logger.logUser(script, LogType.Warning, 'The synchronous version of user.getIdentities method is deprecated. Please provide an options object with success and error callback. Please visit http://go.microsoft.com/fwlink/?LinkId=386291 for details.');
        return this._getIdentitiesSync();
    }

    this._getIdentitiesAsync(script, callbackOrOptions);
};

GetIdentitiesHelper.prototype._getIdentitiesAsync = function (script, callbackOrOptions) {
    var metrics = this.requestContext.metrics,
        logger = this.requestContext.logger,
        self = this,
        callback;

    if (_.isFunction(callbackOrOptions)) {
        metrics.event('api.user.getIdentitiesAync');
        logger.logUser(script, LogType.Warning, 'The user.getIdentities method that takes a function as an argument is deprecated. Please provide an options object with success and error callback. Please visit http://go.microsoft.com/fwlink/?LinkId=386291 for details.');
        callback = callbackOrOptions;
    }
    else {
        metrics.event('api.user.getIdentitiesWithOptionsAync');
        callback = ZumoCallback.create(this.requestContext, logSource, script, 'user', 'getIdentities', callbackOrOptions);
    }

    this.userService.isEnabled(function (err, isEnabled) {
        if (err) {
            callback(err);
            return;
        }

        if (isEnabled && self.token && self.token.claims && self.token.claims.id) {
            self.userService.getUserIdentities(self.token.claims.id, callback);
        }
        else {
            var identities = self._getIdentitiesSync();
            callback(null, identities);
        }
    });
};

GetIdentitiesHelper.prototype._getIdentitiesSync = function (token) {
    var identity = null;

    if (this.token && this.token.getCredentials) {
        identity = _getIdentityFromToken(this.token);
    }

    return identity;
};

function _getIdentityFromToken(token) {
    var credentials = token.getCredentials();

    // TODO: 1372286 After 4/15/2014 return null
    if (!token.claims.ver || token.claims.ver < 2) {
        return credentials;
    }

    if (!token.claims.uid || !credentials) {
        return null;
    }

    var name = UserService.getProviderNameByUserId(token.claims.uid);
    var key = UserService.getProviderKeyByName(name);

    var result = {};
    result[key] = _.extend({ userId: token.claims.uid }, credentials);

    return result;
}

function _getLevel(request, keys) {
    if (request.masterKey && keys.masterKey && (request.masterKey === keys.masterKey)) {
        return 'admin';
    } else if (request.userId) {
        return 'authenticated';
    } else {
        return 'anonymous';
    }
}