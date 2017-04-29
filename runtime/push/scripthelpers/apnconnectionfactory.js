// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
var core = require('../../core');

var resources = require('../../resources');
var StatusCodes = require('../../statuscodes').StatusCodes;
var _ = require('underscore');
var _str = require('underscore.string');
var apns = require('apn');

var ApnConnectionFactory = ((() => {

    function ApnConnectionFactory(certLoader, passphrase, gateway, timeout) {
        this.certLoader = certLoader;
        this.passphrase = passphrase;
        this.gateway = gateway;
        this.timeout = timeout || 300000 /* 5 minutes */;
        this.connection = null;
    }    

    ApnConnectionFactory.prototype.getConnection = function () {
        if (this.connection === null || this._didTimeOut()) {
            this._disposeConnection();
            this._ensureOptions();

            this.connection = this._createConnection();
            this.connection.once('error', this._onError.bind(this));
        }

        this.lastUsed = new Date();
        return this.connection;
    };

    ApnConnectionFactory.prototype._onError = function (err) {
        this.connection = null;
        throw new core.MobileServiceError(_.sprintf(resources.apnsInitializationFailed, err.toString()));
    };

    ApnConnectionFactory.prototype._ensureOptions = function () {
        if (this.options) {
            return this.options;
        }

        var pfxData = this.certLoader();

        this.options = {
            pfxData,
            passphrase: this.passphrase,
            gateway: this.gateway
        };
    };

    ApnConnectionFactory.prototype._didTimeOut = function () {
        var ageInSeconds = new Date() - this.lastUsed;
        var result = ageInSeconds > this.timeout;
        return result;
    };

    ApnConnectionFactory.prototype._createConnection = function () {
        return new apns.Connection(this.options);
    };

    ApnConnectionFactory.prototype._disposeConnection = function () {
        if (this.connection !== null) {
            var self = this;
            this.connection.sockets.forEach(socket => {
                self.connection.destroyConnection(socket);
            });
        }
    };

    return ApnConnectionFactory;
}))();


module.exports = exports = ApnConnectionFactory;
