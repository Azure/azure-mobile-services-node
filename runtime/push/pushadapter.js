// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is used to create an azure notificationHubService

var ZumoCallback = require('../script/zumocallback'),
    notify = require('./scripthelpers/notify'),
    notifyWns = require('./scripthelpers/notify-wns'),
    notifyMpns = require('./scripthelpers/notify-mpns'),
    notifyApns = require('./scripthelpers/notify-apns'),
    notifyGcm = require('./scripthelpers/notify-gcm'),
    NhRegistrationHandler = require('./nhregistrationhandler'),
    path = require('path'),
    _ = require('underscore'),
    azure;

exports = module.exports = PushAdapter;

var logSource = "PushAdapter";

function PushAdapter(configPath, options, credentials) {
    // options.MS_EnableExternalPush could be:
    // undefined--(old ZRP) Legacy mode
    // 'False'--Legacy mode
    // 'true'--notificationHubPush = true
    // Should not be possible, but we will handle the following too:
    // null--Legacy mode
    // ''--Legacy mode
    // 'anyotherstring'--notificationHubPush = true
    if (options.MS_EnableExternalPush && options.MS_EnableExternalPush.toLowerCase() !== 'false') {
        this.notificationHubPush = true;
    } else {
        this.notificationHubPush = false;
    }        

    if (options.MS_NotificationHubConnectionString) {
        this.notificationHubConnectionString = options.MS_NotificationHubConnectionString;
    }

    if (options.MS_NotificationHubName) {
        this.notificationHubName = options.MS_NotificationHubName;
    }

    if (!this.notificationHubPush) {
        this.directPushClients = {};
        this.directPushClients.wnsClient = notifyWns.createWnsContext(credentials.microsoftaccount.clientSecret, credentials.microsoftaccount.packageSid);
        this.directPushClients.mpnsClient = notifyMpns.createMpnsContext();
        this.directPushClients.apnsClient = notifyApns.createApnsContext(path.join(configPath, 'apnscertificate.p12'), options.MS_ApnsCertificatePassword, options.MS_ApnsCertificateMode);
        this.directPushClients.gcmClient = notifyGcm.createGcmContext(credentials.google.gcmApiKey);
    }
}

PushAdapter.prototype.createPushForScripts = function (source, logger, metrics, responseCallback) {
    var push = {};

    if (this.notificationHubPush) {
        var notificationHubService = this.createNotificationHubService('An error occurred creating push for user scripts', logger);
        if (notificationHubService) {
            push = wrapNotificationHubServiceZumoCallback(notificationHubService, source, logger, metrics, responseCallback);
        }
    } else if (!this.notificationHubPush) {
        var self = this;
        // define lazy properties for push provider wrappers
        core.createLazyProperty(push, 'wns', function () {
            return notify.createWrappedClient(self.directPushClients.wnsClient, source, logger, metrics, responseCallback);
        });
        core.createLazyProperty(push, 'mpns', function () {
            return notify.createWrappedClient(self.directPushClients.mpnsClient, source, logger, metrics, responseCallback);
        });
        core.createLazyProperty(push, 'apns', function () {
            return notify.createWrappedClient(self.directPushClients.apnsClient, source, logger, metrics, responseCallback);
        });
        core.createLazyProperty(push, 'gcm', function () {
            return notify.createWrappedClient(self.directPushClients.gcmClient, source, logger, metrics, responseCallback);
        });
    }

    return push;
};

PushAdapter.prototype.createNotificationHubService = function (errorPrefix, logger) {
    if (this.notificationHubConnectionString && this.notificationHubName) {
        try {
            if (!azure) {
                azure = require('azure');
            }

            return azure.createNotificationHubService(this.notificationHubName, this.notificationHubConnectionString);
        } catch (e) {
            var errString = _.sprintf('%s: azure.notificationHubService could not be created. HubName: "%s" ConnectionString "%s": Error from create-%s.', errorPrefix, this.notificationHubName, this.notificationHubConnectionString, e);
            logger.logUser('', LogType.Error, errString);
            logger.error(logSource, errString);
        }
    } else {
        logger.logUser('', LogType.Error, _.sprintf('%s: NotificationHub is not yet active. Check Push tab in the portal for status.', errorPrefix));
    }

    return null;
};

PushAdapter.prototype.createNhRegistrationHandler = function (logger, extensionManager) {
    if (this.notificationHubPush) {
        var notificationHubService = this.createNotificationHubService('An error occurred creating handler for push registrations', logger);
        if (notificationHubService) {
            return new NhRegistrationHandler(notificationHubService, extensionManager);
        }
    }

    return undefined;
};

function wrapNotificationHubServiceZumoCallback(notificationHubService, source, logger, metrics, responseCallback) {
    var allowedMethodPrefix = ['delete', 'get', 'list', 'send', 'update', 'send', 'create'];
    var disallowedMethodPrefix = ['listeners'];
    return ZumoCallback.wrapObject(notificationHubService, 'push.nh', 'Push', source, logger, metrics, allowedMethodPrefix, disallowedMethodPrefix, responseCallback);
}