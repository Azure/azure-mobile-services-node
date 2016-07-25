// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module provides a json web token implementation

var crypto = require('crypto'),
    Encryptor = require('./encryptor'),
    Buffer = require('buffer').Buffer,
    core = require('./core'),
    _ = require('underscore');

exports = module.exports;

function JsonWebToken(keyOrCertificates, signingSuffix) {
    if (core.isString(keyOrCertificates)) {
        this._forSigningKeyDerivation = keyOrCertificates + (signingSuffix || '');
        this._credentialsKey = keyOrCertificates;
    } else {
        this._certificates = keyOrCertificates;
    }
}

JsonWebToken.credentialsClaimName = 'urn:microsoft:credentials';

exports.credentialsClaimName = JsonWebToken.credentialsClaimName;

JsonWebToken.windowsLiveSigningSuffix = 'JWTSig';

exports.windowsLiveSigningSuffix = JsonWebToken.windowsLiveSigningSuffix;

// create builds a JsonWebToken from a set of parameters that will be returned to a Zumo client
// claims is an object or string containing JWT claims
// envelope is an object or string containing JWT envelope
// key is an object containing both the crypto key and the key used to build signature 
// signingSuffix contains a suffix that is appended to the standard JWT signingKey
exports.create = function (claims, envelope, key, signingSuffix) {
    var jwt = new JsonWebToken(key, signingSuffix);

    jwt.setEnvelope(envelope);

    // Encrypt credential claim if present
    if (typeof claims[JsonWebToken.credentialsClaimName] === 'object') {
        jwt._credentials = claims[JsonWebToken.credentialsClaimName];
        var plaintext = JSON.stringify(jwt._credentials);
        claims[JsonWebToken.credentialsClaimName] = Encryptor.encrypt(key, plaintext);
    }

    jwt.setClaims(claims);
    jwt.signature = jwt._buildSignature();

    return jwt;
};

// parse takes a token and makes it into a JsonWebToken object and validates it
// token contains the JWT in string format
// keyOrCertificates is either:
//      1. if envelope.alg is HS256, the key used to validate the signature
//      2. if envelope.alg is RS256, A set of public certificates of the following structures
//         x5t JWTs: [{ x5t: '<certThumprint>', certs: ['<cert1>', '<cert2>'] }]
//         kid JWTs: { 'id': 'cert1', 'id1': 'cert2' }
// signingSuffix contains a suffix that is appended to the standard JWT signingKey when validating the signature
exports.parse = function (token, keyOrCertificates, signingSuffix) {
    var jwt = new JsonWebToken(keyOrCertificates, signingSuffix);

    // Get the token segments & perform validation
    var segments = splitToken(token);

    // Decode and deserialize the envelope
    jwt.setEnvelope(segments[0]);

    // Decode and deserialize the claims
    jwt.setClaims(segments[1]);

    // Get the signature
    jwt.signature = segments[2];

    jwt._validateSignature();

    return jwt;
};

// This is a test hook to allow replay of expired tokens for unit tests
exports.now = function () {
    return new Date();
};

// determine whether this JWT instance has expired
JsonWebToken.prototype.isExpired = function () {
    if (this.claims.exp) {
        return isExpired(this.claims.exp, exports.now());
    }

    return false;
};

// determine whether this JWT instance has invalid NotBefore
JsonWebToken.prototype.isBeforeNotBefore = function () {
    if (this.claims.nbf) {
        return notBefore(this.claims.nbf, exports.now());
    }

    return false;
};

// determine whether this JWT instance has invalid IssuedAt
JsonWebToken.prototype.isBeforeIssuedAt = function () {
    if (this.claims.iat) {
        return notBefore(this.claims.iat, exports.now());
    }

    return false;
};

JsonWebToken.prototype._validateSignature = function () {
    if (this.envelope.alg === "HS256") {
        this.validateSignatureVersusBuiltSignature();
    } else {
        this.verifyRsaSha256Signature();
    }
};

JsonWebToken.prototype.validateSignatureVersusBuiltSignature = function() {
    var signature = this._buildSignature();

    if (signature != this.signature) {
        throw new Error('The authentication token has an invalid signature.');
    }
};

// Used to validate signature for AAD & Google
JsonWebToken.prototype.verifyRsaSha256Signature = function () {
    // First ensure the public key we are checking against matches the one specified in the JWT
    var signatureVerified = false;
    if (this.envelope.x5t) {
        signatureVerified = this.verifyRsaSha256SignatureX5t();            
    } else if (this.envelope.kid) {
        signatureVerified = this.verifyRsaSha256SignatureKid();            
    }

    if (!signatureVerified) {
        throw new Error('The authentication token has invalid signature.');
    }    
};

JsonWebToken.prototype.verifyRsaSha256SignatureX5t = function () {
    var self = this;
    var matchedPublicX5TSets = _.find(this._certificates, function (x5TCertificates) {
        return x5TCertificates.x5t === self.envelope.x5t;
    });

    if (!matchedPublicX5TSets) {
        // The cert was not found. Return this information in the error,
        // so the upstream token owner can refresh the certs and try again
        var err = new Error('The x5t certificate specified was not found.');
        err.x5tNotFound = true;
        throw err;
    }

    // Now check all certs listed as matching against the JWT signature
    return _.some(matchedPublicX5TSets.certs, function (publicKey) {
        return self.verifySignatureByCert(publicKey);        
    });
};

JsonWebToken.prototype.verifyRsaSha256SignatureKid = function() {
    var cert = this._certificates[this.envelope.kid];

    if (typeof (cert) !== 'undefined') {
        if (this.verifySignatureByCert(cert)) {
            return true;
        }
    }
    else {
        // The kid was not found. Return this information in the error,
        // so the upstream token owner can refresh the certs and try again
        var err = new Error('The kid specified was not found.');
        err.kidNotFound = true;
        throw err;
    }

    return false;
};

JsonWebToken.prototype.verifySignatureByCert = function (cert) {
    var verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(this.envelopeSegment + '.' + this.claimsSegment);
    return verifier.verify(cert, core.toBase64FromUrlEncodedBase64(this.signature), 'base64');
};

// Determines whether the provided claims expiry is expired, based on the provided 'now' value
function isExpired(claimsExpiry, dateNow) {
    // Compute the expiration by creating a Date from the claims exp (claimsExpiry is in seconds)
    var expiration = new Date(claimsExpiry * 1000);
    
    return expiration < dateNow;
}
exports.isExpired = isExpired;

// Method returns true if dateNow is before notBefore converted to Date 
// minus 5 minutes to allow for clock differences.
function notBefore(notBeforeSeconds, dateNow) {
    var notBeforeDate = new Date((notBeforeSeconds * 1000) - (5 * 60 * 1000));
    return notBeforeDate > dateNow;
}
exports.notBefore = notBefore;

exports.createIntDateExpiryFromDays = function createIntDateExpiryFromDays(days) {
    var currDate = exports.now();
    var expiryDate = new Date().setUTCDate(currDate.getUTCDate() + days);

    // convert to seconds
    return Math.floor(expiryDate.valueOf() / 1000);
};

JsonWebToken.prototype._buildSignature = function () {
    // derive the signing key
    var hasher = crypto.createHash('sha256');
    hasher.update(this._forSigningKeyDerivation);
    var signingKey = hasher.digest('binary');

    // calculate an HMAC SHA-256 MAC and create the signature
    var hmac = crypto.createHmac('sha256', signingKey);
    hmac.update(this.envelopeSegment + '.' + this.claimsSegment);
    var signature = core.toUrlEncodedBase64FromBase64(hmac.digest('base64'));

    return signature;
};

JsonWebToken.prototype.setClaims = function (claims) {
    if (core.classof(claims) === 'string') {
        this.claimsSegment = claims;
        var decoded = core.base64UrlDecode(claims);
        this.claims = JSON.parse(decoded);
    }
    else {
        var json = JSON.stringify(claims);
        this.claimsSegment = core.base64UrlEncode(json);
        this.claims = claims;
    }

    this._validateClaims();
};

JsonWebToken.prototype._validateClaims = function () {
    // JWT does not technically require exp.
    // Including it explicitly for compat with old behavior and to help ensure forever expirations aren't allowed by Zumo.
    if (!this.claims.exp) {
        throw new Error("The authentication token requires expiration claim.");
    }

    if (this.isExpired()) {
        throw new Error("The authentication token has expired.");
    }

    if (this.isBeforeIssuedAt()) {
        throw new Error("The authentication token is not valid until after its IssuedAt.");
    }

    if (this.isBeforeNotBefore()) {
        throw new Error("The authentication token is not valid until after its NotBefore.");
    }
};

JsonWebToken.prototype.getCredentials = function () {
    if (this._credentials === undefined) {
        // Attempt to decrypt credentials if present
        if (typeof this.claims[JsonWebToken.credentialsClaimName] === 'object') {
            this._credentials = this.claims[JsonWebToken.credentialsClaimName];
        }
        else if (typeof this.claims[JsonWebToken.credentialsClaimName] === 'string') {
            var data = this.claims[JsonWebToken.credentialsClaimName];
            var plaintext = Encryptor.decrypt(this._credentialsKey, data);
            this._credentials = JSON.parse(plaintext);
        }
        else {
            this._credentials = null;
        }
    }

    return this._credentials;
};

JsonWebToken.prototype.setEnvelope = function (envelope) {
    if (core.classof(envelope) === 'string') {
        this.envelopeSegment = envelope;
        var decoded = core.base64UrlDecode(envelope);
        this.envelope = JSON.parse(decoded);
    }
    else {
        var json = JSON.stringify(envelope);
        this.envelopeSegment = core.base64UrlEncode(json);
        this.envelope = envelope;
    }

    this._validateEnvelope();
    this._alg = this.envelope.alg;
};

JsonWebToken.prototype._validateEnvelope = function () {
    // typ is not strictly required per the JSON spec. This class assumes JWT if not provided.
    if (this.envelope.typ && this.envelope.typ != 'JWT') {
        throw new Error("The authentication token type is invalid.");
    }

    if (!this.envelope.alg ||
        // Zumo JWT tokens use HS256 and AAD JWT tokens use RS256
        (this.envelope.alg != 'HS256' && this.envelope.alg != 'RS256'))
    {
        throw new Error("The authentication token alg is not supported.");
    }
};

JsonWebToken.prototype.toString = function () {
    return this.envelopeSegment + '.' + this.claimsSegment + '.' + this.signature;
};

function splitToken(token) {
    if (!token) {
        throw new Error('Invalid token format. Token must not be empty.');
    }

    var segments = token.split('.');

    if (segments.length != 3) {
        throw new Error('Invalid token format. Expected Envelope.Claims.Signature.');
    }

    if (!segments[0]) {
        throw new Error("Invalid token format. Envelope must not be empty.");
    }

    if (!segments[1]) {
        throw new Error("Invalid token format. Claims must not be empty.");
    }

    if (!segments[2]) {
        throw new Error("Invalid token format. Signature must not be empty.");
    }

    return segments;
}