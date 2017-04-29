// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is the helper to assist nhregistrationhandler with Apns registration operations

var core = require('../../core');

exports = module.exports = ApnsHandler;

function ApnsHandler(nhRegistrationHandler) {
    this.nhRegistrationHandler = nhRegistrationHandler;
}

// Transform a javascript object fed to nhRegistrationHandler to an ordered, case sensitive javascript object ready for notificationHubService
// Format of result object:
// {
//   RegistrationId: '', --REQUIRED
//   Tags: 'tag1,tag2', --OPTIONAL
//   DeviceToken: '', --REQUIRED
//   BodyTemplate: '', --OPTIONAL--this controls whether this is a template
//   Expiry: '', --OPTIONAL--this should be an ISO formatted date/time when APNS should stop sending notifcation to device if not yet successful. Only used for template registrations.
//   TemplateName: '', --OPTIONAL (REQUIRED if BodyTemplate is provided)
//   _: --REQUIRED/UNORDERED--property bag with many optional properties, but only one is set here
//   _.ContentRootElement: --REQUIRED/UNORDERED-controls the type of the SOAP object eventually sent to notification hub
// }
ApnsHandler.prototype.transformInputToNhRegistration = function (inputRegistration) {
    var registration = this.nhRegistrationHandler.transformInputToNhBaseRegistration(inputRegistration);

    if (!inputRegistration.deviceId) {
        throw new core.MobileServiceError('Creating or updating an Apns registration requires the body to contain a deviceId containing a Device Token', core.ErrorCodes.BadInput);
    }

    registration.DeviceToken = inputRegistration.deviceId;

    if (inputRegistration.templateBody) {
        registration._.ContentRootElement = 'AppleTemplateRegistrationDescription';
        registration.BodyTemplate = inputRegistration.templateBody;

        if (inputRegistration.expiration) {
            registration.Expiry = inputRegistration.expiration;
        }

        if (inputRegistration.templateName) {
            registration.TemplateName = inputRegistration.templateName;
        } else {
            throw new core.MobileServiceError('Creating or updating a registration with a templateBody provided also requires a templateName as part of the body', core.ErrorCodes.BadInput);
        }
    } else {
        registration._.ContentRootElement = 'AppleRegistrationDescription';
    }

    return registration;
};

// Provides the specific method to list registrations
ApnsHandler.prototype.listRegistrations = function (deviceId, callback) {
    this.nhRegistrationHandler.notificationHubService.apns.listRegistrationsByToken(deviceId, callback);
};

// Provides the specific property to snag the unique registration Id from
ApnsHandler.prototype.getDeviceIdFromNhRegistration = regFromNh => regFromNh.DeviceToken;

// Converts any optional template members from Service Bus for this notifcation service into members of registration object
// for transfer to the client
ApnsHandler.prototype.convertOptionalTemplatePropsToOutputRegistration = (regFromNh, registration) => {
    if (regFromNh.Expiry) {
        registration.expiry = regFromNh.Expiry;
    }
};