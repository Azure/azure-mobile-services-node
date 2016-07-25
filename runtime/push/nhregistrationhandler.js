// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is for handling requests to:
// POST http://myapp.azure-mobile.net/push/registrationids
// PUT/DELETE http://myapp.azure-mobile.net/push/registrations/<id>
// GET http://myapp.azure-mobile.net/push/registrations?deviceId=<channelUri/deviceToken/gcmRegistrationId>&platform=<platform>
// These endpoints facilitate the client's registrations for NotificationHubs

var StatusCodes = require('../statuscodes').StatusCodes,
    _ = require('underscore'),
    _str = require('underscore.string'),
    ApnsHandler = require('./nhregistrationhelpers/apns'),
    GcmHandler = require('./nhregistrationhelpers/gcm'),
    MpnsHandler = require('./nhregistrationhelpers/mpns'),
    WnsHandler = require('./nhregistrationhelpers/wns');
_.mixin(_str.exports());

exports = module.exports = NhRegistrationHandler;

var logSource = 'NhRegistrationHandler';

function NhRegistrationHandler(notificationHubService, extensionManager) {
    this.notificationHubService = notificationHubService;
    this.extensionManager = extensionManager;
    this.handlers = {
        apns: new ApnsHandler(this),
        gcm: new GcmHandler(this),
        mpns: new MpnsHandler(this),
        wns: new WnsHandler(this)
    };
}

// POST http://myapp.azure-mobile.net/push/registrationsids
// Success returns 201
NhRegistrationHandler.prototype.handlePost = function (req) {
    var context = req._context,
        responseCallback = context.responseCallback,
        headers,
        logger = context.logger,
        metrics = context.metrics,
        metricName = 'registration.createId';

    try {
        this.notificationHubService.createRegistrationId(function (error, response) {
            try {
                if (error) {
                    metrics.event(_.sprintf('%s.%s', metricName, 'error'));
                    handleNotificationHubError(
                        logger,
                        responseCallback,
                        error,
                        'Error creating or updating the push registration');
                } else {
                    // Location …/push/registrationids/{regId}
                    headers = {};
                    headers.location = 'http://' + req.headers.host + '/push/registrations/' + response;

                    metrics.event(_.sprintf('%s.%s', metricName, 'success'));
                    responseCallback(null, null, StatusCodes.CREATED, headers);
                }
            } catch (e) {
                logger.trace(logSource, _.sprintf('createRegistrationId callback threw error: %s', e));
                responseCallback(new core.MobileServiceError(e));
            }
        });
    } catch (e) {
        metrics.event(_.sprintf('%s.%s', metricName, 'error'));
        throw e;
    }
};

// PUT http://myapp.azure-mobile.net/push/registrations/<id>
// requestBody should have the following format--
// {
// platform: "wns" // {"wns"|"mpns"|"apns"|"gcm"}--REQUIRED
// deviceId: "" // unique device token--REQUIRED
// tags: "tag"|["a","b"] // non-empty string or array of tags (optional)
// templateBody: '<toast> --OPTIONAL (this triggers template object building)
//      <visual lang="en-US">
//        <binding template="ToastText01">
//          <text id="1">$(myTextProp1)</text>
//        </binding>
//      </visual>
//    </toast>' // if template registration
// templateName: "" // if template registration -- OPTIONAL (REQUIRED if template)
// headers: { // if wns/mpns template registration } -- OPTIONAL (used on WNS/MPNS templates)
// expiration: "" // if apns template -- OPTIONAL (used on APNS templates)
// }
// Success returns 204
NhRegistrationHandler.prototype.handlePut = function (req) {
    var context = req._context,
        requestBody = req.body,
        responseCallback = context.responseCallback,
        platform,
        registration,
        logger = context.logger,
        metrics = context.metrics,
        metricName = 'registration.update',
        installationId = req.headers['x-zumo-installation-id'],
        self = this;

    if (!requestBody) {
        throw new core.MobileServiceError('Creating or updating registrations requires a body containing a push registration', core.ErrorCodes.BadInput);
    }

    platform = requestBody.platform;
    metricName = _.sprintf('%s.%s', metricName, platform);

    try {
        requestBody.registrationId = context.parsedRequest.id;
        requestBody.tags = requestBody.tags || [];

        if (installationId) {
            if (!_.contains(requestBody.tags, installationId)) {
                requestBody.tags.push(installationId);
            }
        }

        this.extensionManager.runPushRegistrationScript(requestBody, req.user, function (scriptError) {
            try {
                if (scriptError) {
                    handleUserScriptError(logger, responseCallback, scriptError, 'Registration script failed with error');
                    return;
                }

                registration = self.getHandler(platform).transformInputToNhRegistration(requestBody);

                registration.Tags = registration.Tags.join();

                self.notificationHubService.createOrUpdateRegistration(registration, function (error) {
                    try {
                        if (error) {
                            metrics.event(_.sprintf('%s.%s', metricName, 'error'));

                            // Runtime must flow 410, StatusCodes.GONE, on PUT to client so it can know to request a new Registration Id
                            // This can occur if registration expires or if the notifcation hub attached to service is changed.
                            if (error.statusCode && error.statusCode == StatusCodes.GONE) {
                                responseCallback(null, error.detail, StatusCodes.GONE);
                            } else {
                                handleUserScriptError(logger, responseCallback, error, 'Error creating or updating the push registration');
                            }
                        } else {
                            metrics.event(_.sprintf('%s.%s', metricName, 'success'));
                            responseCallback(null, null, StatusCodes.NO_CONTENT);
                        }
                    } catch (postRegError) {
                        handleUserScriptError(logger, responseCallback, postRegError, 'Error completing the creation or update of push registration');
                    }
                });
            } catch (preRegError) {
                metrics.event(_.sprintf('%s.%s', metricName, 'error'));
                handleUserScriptError(logger, responseCallback, preRegError, 'Registration validation threw error');
            }
        });
    } catch (preScriptError) {
        metrics.event(_.sprintf('%s.%s', metricName, 'error'));
        throw preScriptError;
    }
};

// The first 2 parts of a inputRegistration for any service are:
// 1. registrationId (required)
// 2. tags (optional
NhRegistrationHandler.prototype.transformInputToNhBaseRegistration = function (inputRegistration) {
    var registration = {};

    // The _ property on the registration is used by notificationHubService for storing various metadata such as the type of the registration object for SOAP
    registration._ = {};

    if (!inputRegistration.registrationId) {
        throw new core.MobileServiceError('Creating or updating a registration requires a valid registration ID');
    }

    registration.RegistrationId = inputRegistration.registrationId;

    if (inputRegistration.tags) {
        if (!_.isArray(inputRegistration.tags)) {
            throw new core.MobileServiceError('The registration tags specified are invalid. Tags must be an array or null');
        }

        registration.Tags = inputRegistration.tags;
    } else {
        registration.Tags = [];
    }

    return registration;
};

// DELETE http://myapp.azure-mobile.net/push/registrations/<id>
// Success returns 200
NhRegistrationHandler.prototype.handleDelete = function (req) {
    var context = req._context,
        responseCallback = context.responseCallback,
        logger = context.logger,
        metrics = context.metrics,
        metricName = 'registration.delete';

    try {
        this.notificationHubService.deleteRegistration(context.parsedRequest.id, function (error) {
            try {
                if (error) {
                    metrics.event(_.sprintf('%s.%s', metricName, 'error'));
                    handleNotificationHubError(
                        logger,
                        responseCallback,
                        error,
                        'Error deleting the push registration');
                } else {
                    metrics.event(_.sprintf('%s.%s', metricName, 'success'));
                    responseCallback(null, null, StatusCodes.OK);
                }
            } catch (e) {
                logger.trace(logSource, _.sprintf('deleteRegistration callback threw error: %s', e));
                responseCallback(new core.MobileServiceError(e));
            }
        });
    } catch (e) {
        metrics.event(_.sprintf('%s.%s', metricName, 'error'));
        throw e;
    }
};

// GET http://myapp.azure-mobile.net/push/registrations?deviceId=<channelUri/deviceToken/gcmRegistrationId>&platform=<platform>
// Success returns 200
NhRegistrationHandler.prototype.handleGet = function (req) {
    var context = req._context,
        platform = req.query.platform,
        platformHandler,
        logger = context.logger,
        responseCallback = context.responseCallback,
        metricName = _.sprintf('registration.list.%s', platform),
        metrics = context.metrics;

    try {
        if (!req.query.deviceId) {
            throw new core.MobileServiceError('Listing registrations requires a deviceId query parameter', core.ErrorCodes.BadInput);
        }

        platformHandler = this.getHandler(platform);

        platformHandler.listRegistrations(req.query.deviceId, function (error, response) {
            try {
                handleListRegistrationsResponse(req, error, response, platform, platformHandler);
            } catch (e) {
                logger.trace(logSource, _.sprintf('listRegistrations callback threw error: %s', e));
                responseCallback(new core.MobileServiceError(e));
            }
        });
    } catch (e) {
        metrics.event(_.sprintf('%s.%s', metricName, 'error'));
        throw e;
    }
};

// callback for converting the response for listing registrations
function handleListRegistrationsResponse(req, error, response, platform, platformHandler) {
    var context = req._context,
        responseCallback = context.responseCallback,
        logger = context.logger,
        metrics = context.metrics,
        metricName = _.sprintf('registration.list.%s', platform);

    if (error) {
        metrics.event(_.sprintf('%s.%s', metricName, 'error'));
        handleNotificationHubError(
                logger,
                responseCallback,
                error,
                'Error getting registration list');
    } else {
        metrics.event(_.sprintf('%s.%s', metricName, 'success'));
        responseCallback(null, convertToOutputRegistrationArray(platformHandler, response), StatusCodes.OK);
    }
}

// returns the specific platform's specific handler
NhRegistrationHandler.prototype.getHandler = function (platform) {
    if (!platform) {
        throw new core.MobileServiceError('Creating, updating or listing registrations requires a platform to be provided', core.ErrorCodes.BadInput);
    }

    if (!_.has(this.handlers, platform)) {
        throw new core.MobileServiceError(_.sprintf('Unsupported push platform specified. Supported push platforms are "%s"', _.keys(this.handlers)), core.ErrorCodes.BadInput);
    }

    return this.handlers[platform];
};

// Converting a success response for listing registrations to output format
function convertToOutputRegistrationArray(platformHandler, nhListResponse) {
    var registrations = [];
    _.each(nhListResponse, function (regFromNh) { convertToOutputRegistration(platformHandler, regFromNh, registrations); });
    return registrations;
}

// Converting each individual registration part of a success response for listing registrations to output format
function convertToOutputRegistration(platformHandler, regFromNh, registrations) {
    var registration = {};

    registration.registrationId = regFromNh.RegistrationId;
    if (regFromNh.Tags) {
        registration.tags = regFromNh.Tags.split(',');
    }

    registration.deviceId = platformHandler.getDeviceIdFromNhRegistration(regFromNh);

    if (regFromNh.BodyTemplate) {
        registration.templateBody = regFromNh.BodyTemplate;
    }

    platformHandler.convertOptionalTemplatePropsToOutputRegistration(regFromNh, registration);

    if (regFromNh.TemplateName) {
        registration.templateName = regFromNh.TemplateName;
    }

    registrations.push(registration);
}

// Wraps, logs, metrics and responds to any error from notificationHubService
function handleUserScriptError(logger, responseCallback, error, userlogPrefix) {
    var loggableError;
    if (error.constructor !== core.MobileServiceError) {
        loggableError = new core.MobileServiceError(error);
    } else {
        loggableError = error;
    }

    logger.logUser('', LogType.Error, _.sprintf('%s-%s.', userlogPrefix, loggableError));
    responseCallback(loggableError, null, StatusCodes.INTERNAL_SERVER_ERROR);
}

// Wraps, logs, metrics and responds to any error from notificationHubService
function handleNotificationHubError(logger, responseCallback, error, userlogPrefix) {
    var loggableError;
    if (error.constructor !== core.MobileServiceError) {
        loggableError = new core.MobileServiceError(error);
    } else {
        loggableError = error;
    }

    logger.trace(logSource, _.sprintf('%s-%s', userlogPrefix, error));
    logger.logUser('', LogType.Error, _.sprintf('%s-%s.', userlogPrefix, loggableError));
    responseCallback(loggableError, null, StatusCodes.INTERNAL_SERVER_ERROR);
}