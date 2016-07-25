// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is the helper to assist nhregistrationhandler with Gcm registration operations

var core = require('../../core');

exports = module.exports = GcmHandler;

function GcmHandler(nhRegistrationHandler) {
    this.nhRegistrationHandler = nhRegistrationHandler;
}

// Transform a javascript object fed to nhRegistrationHandler to an ordered, case sensitive javascript object ready for notificationHubService
// Format of result object:
// {
//   RegistrationId: '', --REQUIRED
//   Tags: 'tag1,tag2', --OPTIONAL
//   GcmRegistrationId: '', --REQUIRED
//   BodyTemplate: '', --OPTIONAL--this controls whether this is a template
//   TemplateName: '', --OPTIONAL (REQUIRED if BodyTemplate is provided)
//   _: --REQUIRED/UNORDERED--property bag with many optional properties, but only one is set here
//   _.ContentRootElement: --REQUIRED/UNORDERED-controls the type of the SOAP object eventually sent to notification hub
// }
GcmHandler.prototype.transformInputToNhRegistration = function (inputRegistration) {
    var registration = this.nhRegistrationHandler.transformInputToNhBaseRegistration(inputRegistration);

    if (!inputRegistration.deviceId) {
        throw new core.MobileServiceError('Creating or updating a Gcm registration requires the body to contain a deviceId containing a GcmRegistrationId', core.ErrorCodes.BadInput);
    }

    registration.GcmRegistrationId = inputRegistration.deviceId;

    if (inputRegistration.templateBody) {
        registration._.ContentRootElement = 'GcmTemplateRegistrationDescription';
        registration.BodyTemplate = inputRegistration.templateBody;

        if (inputRegistration.templateName) {
            registration.TemplateName = inputRegistration.templateName;
        } else {
            throw new core.MobileServiceError('Creating or updating a registration with a templateBody provided also requires a templateName as part of the body', core.ErrorCodes.BadInput);
        }
    } else {
        registration._.ContentRootElement = 'GcmRegistrationDescription';
    }

    return registration;
};

// Provides the specific method to list registrations
GcmHandler.prototype.listRegistrations = function (deviceId, callback) {
    this.nhRegistrationHandler.notificationHubService.gcm.listRegistrationsByGcmRegistrationId(deviceId, callback);
};

// Provides the specific property to snag the unique registration Id from
GcmHandler.prototype.getDeviceIdFromNhRegistration = function (regFromNh) {
    return regFromNh.GcmRegistrationId;
};

// Converts any optional template members from Service Bus for this notifcation service into members of registration object
// for transfer to the client
// regFromNh, registration are default params, but are unused
// Gcm currently has no optimal template properties
GcmHandler.prototype.convertOptionalTemplatePropsToOutputRegistration = function () {
};