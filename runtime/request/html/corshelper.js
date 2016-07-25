// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// Supplies CORS headers as per app configuration

function CorsHelper(options) {

    var url = require('url');

    var defaultCrossDomainWhitelist = [
            { host: 'localhost' }
        ],
        configuredCrossDomainWhitelist = options.crossDomainWhitelist || defaultCrossDomainWhitelist,
        isNullAllowed = false,
        allowedHostNamesRegexes = getHostNameRegexesFromConfiguredWhitelist(configuredCrossDomainWhitelist),
        allowedHeadersRegex = /^[a-z0-9\-\,\s]{1,500}$/i; // Lenient enough to match any header names we will ever use

    this.getCorsHeaders = function (request) {
        var incomingHeaders = request.headers || {},
            requestedOrigin = incomingHeaders.origin,
            requestedHeaders = incomingHeaders['access-control-request-headers'],
            corsHeaders = {};

        if (requestedOrigin && this.isAllowedOrigin(requestedOrigin)) {
            // CORS doesn't permit multiple origins or wildcards, so the standard
            // pattern is to validate the incoming origin and echo it back if accepted.
            corsHeaders['Access-Control-Allow-Origin'] = requestedOrigin;

            if (requestedHeaders && allowedHeadersRegex.test(requestedHeaders)) {
                // CORS doesn't permit * here, so echo back whatever is requested
                // assuming it doesn't contain bad characters and isn't too long.
                corsHeaders['Access-Control-Allow-Headers'] = requestedHeaders;
            }

            if (request.method == 'OPTIONS') {
                // we only want to send these headers on preflight requests
                corsHeaders['Access-Control-Allow-Methods'] = 'GET, PUT, PATCH, POST, DELETE, OPTIONS';
                corsHeaders['Access-Control-Max-Age'] = options.crossDomainMaxAge || 300;
            }
        }

        return corsHeaders;
    };

    this.isAllowedOrigin = function (origin) {
        // special case 'null' that is sent from browser on local files
        if (isNullAllowed && origin === 'null') {
            return true;
        }

        // Extract the components of the origin
        var parsedOrigin = url.parse(origin),
            originHostName = parsedOrigin && parsedOrigin.hostname, // Note that "host" includes the port; "hostname" doesn't
            originProtocol = parsedOrigin && parsedOrigin.protocol,
            originPath = parsedOrigin && parsedOrigin.path;

        // Validate protocol
        if (!originProtocol || !isAllowedProtocol(originProtocol)) {
            return false;
        }

        // Validate path (note: it's typically null)
        if (!isAllowedPath(originPath)) {
            return false;
        }

        // Validate host name
        if (!originHostName) {
            return false;
        }

        return allowedHostNamesRegexes.some(function (hostNameRegex) {
            return hostNameRegex.test(originHostName);
        });
    };
    
    function isAllowedProtocol(protocol) {
        // This means that filesystem origins ("null") aren't supported right now
        // even if you allow "*"
        return protocol === 'http:' || protocol === 'https:' || protocol === 'ms-appx-web:';
    }
    
    function isAllowedPath(path) {
        // The W3C spec isn't especially clear about host origins should be formatted,
        // so to be graceful we permit trailing slashes even though I'm not aware of a
        // browser that sends them. But for the sake of being locked down, anything
        // beyond the slash is disallowed.
        return !path || path === '/';
    }

    function wildcardToRegexPattern(str) {
        // Only supported wildcard character is *; all else is escaped
        return regexEscape(str).replace(/\\\*/, '[a-z0-9\\-\\.]*');
    }

    function regexEscape(str) {
        return str.replace(/([.?*+\^$\[\]\\(){}|\-])/g, '\\$1');
    }

    function getHostNameRegexesFromConfiguredWhitelist(whitelist) {
        // Input is the raw data from ZRP, e.g.:
        // [ 
        //    { host: "*.example1.com" }, 
        //    { host: "www.example2.com" }
        // ]
        //
        // Output is an array of Regex instances, like this:
        // [
        //    new RegExp('^[a-z0-9\-]*\.example1\.com$', 'i'),
        //    new RegExp('^www\.example2\.com$', 'i')
        // ]

        var result = [];

        if (whitelist) {
            whitelist.forEach(function (whitelistEntry) {
                if (!whitelistEntry) {
                    return;
                }
                else if (whitelistEntry.host === 'null') {
                    isNullAllowed = true;
                    return;
                }

                if (whitelistEntry.host) {
                    var pattern = '^' + wildcardToRegexPattern(whitelistEntry.host) + '$';
                    result.push(new RegExp(pattern, 'i'));
                }
            });
        }

        return result;
    }
}

exports = module.exports = CorsHelper;