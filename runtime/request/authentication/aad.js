// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is the handler for AAD login operations.  Like all provider
// login modules, it implements a very specific interface that is documented in
// ../loginhandler.js.

var core = require('../../core'),
    crypto = require('crypto'),
    jsonWebToken = require('../../jsonwebtoken'),
    Buffer = require('buffer').Buffer,
    LoginHandler = require('../loginhandler.js'),
    AadCert = require('./aadcert'),
    certCacheHelper = require('./certcachehelper'),
    _ = require('underscore'),
    _str = require('underscore.string'),
    request = require('request'),
    xml2js = require('xml2js');

_.mixin(_str.exports());

exports = module.exports = AadLoginHandler;

function AadLoginHandler(authenticationCredentials, logger, domainSuffix) {
    this.authenticationCredentials = authenticationCredentials;
    this.loginEndpoint = getLoginEndpoint(domainSuffix);
    this.aadCert = new AadCert(logger, this.loginEndpoint);
    this.name = 'Aad';
    this.logger = logger;
}

var MooncakeLoginEndpoint = "login.chinacloudapi.cn";
var ZumoLoginEndpoint = "login.windows.net";

// Cookie used to ensure against some cross-site scripting attacks.  The nonce is set
// by us in the cookie and in the token from AAD.
// We check to ensure that the two agree.
var NonceCookieName = 'wams_nonce';

// AAD OpenID implements Nonce in place of oAuthState
AadLoginHandler.prototype.oAuthStateNotSupported = true;

// perform any required async startup initialization
AadLoginHandler.prototype.initialize = function (done) {
    this._initializeIssuers(done);
};

AadLoginHandler.prototype.isNewServerFlowRequest = function (request) {
    var isNewFlow = true;

    // If the query includes either a 'id_token' parameter or an 'error' parameter
    // then this is the continuation of a server authentication flow already in progress.
    if (request.query && (request.query.error || request.query.id_token)) {
        isNewFlow = false;
    }

    return isNewFlow;
};

AadLoginHandler.prototype.getNewServerFlowResponseHeaders = function (request, currentUri, callback, options) {
    // Redirect Uri
    var aadUri = _.sprintf('https://%s/common/oauth2/authorize?response_type=id_token&response_mode=query&client_id=%s&redirect_uri=%s',
        this.loginEndpoint,
        this.authenticationCredentials.aad.clientId,
        currentUri);
    var headers = { Location: aadUri };

    // Build Nonce header
    var nonce = LoginHandler.createOAuthRedirectState();
    LoginHandler.addCookieToHeaders(NonceCookieName, nonce, headers);
    headers.Location += '&nonce=' + encodeURIComponent(nonce);

    callback(null, headers);
};

AadLoginHandler.prototype.getProviderTokenFromClientFlowRequest = function (request, callback) {
    callback(new core.MobileServiceError('POST of AAD token is not supported.', core.ErrorCodes.MethodNotAllowed), null);
};

AadLoginHandler.prototype.getProviderTokenFromServerFlowRequest = function (request, currentUri, callback) {
    // If AAD has redirected an error to us, report it to the caller.
    if (request.query.error) {
        var errorMessage = request.query.error;
        if (request.query.error_description) {
            errorMessage = errorMessage + ': ' + request.query.error_description;
        }

        callback(new Error(errorMessage), null);
        return;
    }

    var clientId = this.authenticationCredentials.aad.clientId,
        idToken = request.query.id_token,
        self = this;

    certCacheHelper.validateToken(this.aadCert, idToken, function (error, validatedToken) {
        if (error) {
            callback(error, null);
            return;
        }

        var claims = validatedToken.claims;

        verifyNoOpenIdNonceErrors(request, claims);

        // verify the client id
        if (claims.aud !== clientId) {
            error = new Error("AAD token claims.aud does not match specified clientId.");
        }

        // verify that the issuer is in the list of configured tenants
        // iss will be of the form https://sts.windows.net/<tenantid>
        if (!self._issuerIsValid(claims.iss)) {
            error = new Error("AAD token claims.iss is not the set of tenants configured for the service.");
        }

        callback(error, claims);
    });
};

AadLoginHandler.prototype.getAuthorizationDetailsFromProviderToken = function (request, claims, callback, options) {
    var authorizationDetails = {
        providerId: claims.sub, // sub is the only 100% unique claims field that is on all AAD users regardless of their type
        claims: {
            tenantId: claims.tid
        },
        secrets: {
            oid: claims.oid // oid is necessary for any calls into AAD to check user's permissions
        }
    };

    callback(null, authorizationDetails);
};

// resolve any configured tenant domains to their corresponding issuer values
// by querying AAD metadata for each
AadLoginHandler.prototype._initializeIssuers = function (done) {
    var tenants = this.authenticationCredentials.aad.tenants,
        self = this;

    if (!tenants) {
        // if no tenants are configured, no work to do
        done();
        return;
    }

    // create a set of tasks, each of which will query AAD metadata
    // for a tenant domain and return the corresponding issuer
    self.validIssuers = [];
    var tasks = _.map(tenants, function (tenant) {
        return function (done) {
            self._getIssuerForTenantDomain(tenant, function (err, issuer) {
                if (err) {
                    var msg = _.sprintf(
                        "Error attempting to query tenant metadata for tenant '%s'. Please verify that each of the " +
                        "tenants specified is a valid tenant domain (e.g., abc.onmicrosoft.com). %s", tenant, err);
                    var ex = new core.MobileServiceError(msg, core.ErrorCodes.BadInput);
                    self.logger.logUser('', LogType.Error, ex);
                    throw ex;
                }
                self.validIssuers.push(issuer);
                done();
            });
        };
    });

    // now execute the tasks in parallel
    core.async.parallel(tasks, done);
};

// Call out to the AAD metadata endpoint for the specified tenant domain
// to get the issuer. E.g. test.onmicrosoft.com => https://sts.windows.net/ae549c78-14a5-4fc8-9719-df4e1007990a
AadLoginHandler.prototype._getIssuerForTenantDomain = function (tenant, callback) {
    var metadataUri = _.sprintf('https://%s/%s/federationmetadata/2007-06/federationmetadata.xml', this.loginEndpoint, tenant),
        parser = new xml2js.Parser();

    request(metadataUri, function (err, res, body) {
        if (res.statusCode != 200) {
            // if the response body includes error details return them
            err = body || 'An unspecified error occurred.';
            callback(err);
        }
        else {
            // Transform the metadata xml to json
            // The xml is of the form <EntityDescriptor ID="_72f254cc-cfe3-47f0-af40-d64fe471ed67" entityID="https://sts.windows.net/fe549c78-14a5-4fc8-9719-df4e1007990a/" ... />
            // We only use the entityID portion
            body = _.trim(body);
            var metadata = parser.parseString(body);

            // Read the entityID from the attributes
            var entityAttributes = metadata.tag.attributes;
            var issuer = _.rtrim(entityAttributes.entityID, '/');

            callback(null, issuer);
        }
    });
};

// returns true if the specified issuer is in the configured
// tenant list.
AadLoginHandler.prototype._issuerIsValid = function (issuer) {
    if (!this.validIssuers) {
        // if no tenants have been configured, no validation
        // is performed
        return true;
    }

    issuer = _.rtrim(issuer, '/');
    return this.validIssuers.indexOf(issuer) != -1;
};

function verifyNoOpenIdNonceErrors(request, claims) {
    var cookieNonce = LoginHandler.getCookieFromHeaders(NonceCookieName, request.headers);
    var claimsNonce = claims.nonce;

    if (claimsNonce && !cookieNonce) {
        throw new Error('Redirect from AAD does not contain the required nonce cookie.');
    }

    if (!claimsNonce) {
        throw new Error('Redirect from AAD does not contain the required nonce claim.');
    }

    if (cookieNonce !== claimsNonce) {
        throw new Error('Redirect from AAD does not contain a valid nonce claim.');
    }
}

function getLoginEndpoint(domainSuffix) {
    if (domainSuffix && _.endsWith(domainSuffix.toLowerCase(), '.cn')) {
        return MooncakeLoginEndpoint;
    }
    else {
        return ZumoLoginEndpoint;
    }
}
