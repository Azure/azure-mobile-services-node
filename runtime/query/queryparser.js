// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------

(function (global) {

    require('./expressions');

    var _ = require('underscore'),
        _str = require('underscore.string'),
        core = require('../core');

 _.mixin(_str.exports());

    TokenId = {
        Unknown: 'Unknown',
        End: 'End',
        Identifier: 'Identifier',
        StringLiteral: 'StringLiteral',
        IntegerLiteral: 'IntegerLiteral',
        RealLiteral: 'RealLiteral',
        Not: 'Not',
        Modulo: 'Modulo',
        OpenParen: 'OpenParen',
        CloseParen: 'CloseParen',
        Multiply: 'Multiply',
        Add: 'Add',
        Sub: 'Sub',
        Comma: 'Comma',
        Minus: 'Minus',
        Dot: 'Dot',
        Divide: 'Divide',
        LessThan: 'LessThan',
        Equal: 'Equal',
        GreaterThan: 'GreaterThan',
        NotEqual: 'NotEqual',
        And: 'And',
        LessThanEqual: 'LessThanEqual',
        GreaterThanEqual: 'GreaterThanEqual',
        Or: 'Or'
    };

    var ctor = function (expression) {
        this.keywords = this._createKeywords();

        // define the default root parameter for all member expressions
        this.it = new ParameterExpression();

        this.text = expression;
        this.textLen = this.text.length;
        this.token = {};
        this._setTextPos(0);
        this._nextToken();
    };

    var classMembers = {
        filter: function (predicate) {
            var parser = new QueryParser(predicate);
            var filter = parser.parse();
            return filter;
        },

        orderBy: function (ordering) {
            var parser = new QueryParser(ordering);
            var orderings = parser.parseOrdering();
            return orderings;
        }
    };

    var instanceMembers = {
        parse: function () {
            var exprPos = this.token.pos;
            var expr = this._parseExpression();

            this._validateToken(TokenId.End, 'Syntax error');
            return expr;
        },

        parseOrdering: function () {
            var orderings = [];
            while (true) {
                var expr = this._parseExpression();
                var ascending = true;
                if (this._tokenIdentifierIs('asc')) {
                    this._nextToken();
                }
                else if (this._tokenIdentifierIs('desc')) {
                    this._nextToken();
                    ascending = false;
                }
                orderings.push({
                    selector: expr,
                    ascending: ascending
                });
                if (this.token.id != TokenId.Comma) {
                    break;
                }
                this._nextToken();
            }
            this._validateToken(TokenId.End, 'Syntax error');
            return orderings;
        },

        _tokenIdentifierIs: function (id) {
            return this.token.id == TokenId.Identifier && id == this.token.text;
        },

        _parseExpression: function () {
            return this._parseLogicalOr();
        },

        // 'or' operator
        _parseLogicalOr: function () {
            var left = this._parseLogicalAnd();
            while (this.token.id == TokenId.Or) {
                this._nextToken();
                var right = this._parseLogicalAnd();
                left = new BinaryExpression(left, right, ExpressionType.Or);
            }
            return left;
        },

        // 'and' operator
        _parseLogicalAnd: function () {
            var left = this._parseComparison();
            while (this.token.id == TokenId.And) {
                this._nextToken();
                var right = this._parseComparison();
                left = new BinaryExpression(left, right, ExpressionType.And);
            }
            return left;
        },

        _parseComparison: function () {
            var left = this._parseAdditive();
            while (this.token.id == TokenId.Equal || this.token.id == TokenId.NotEqual || this.token.id == TokenId.GreaterThan ||
                this.token.id == TokenId.GreaterThanEqual || this.token.id == TokenId.LessThan || this.token.id == TokenId.LessThanEqual) {

                var opId = this.token.id;
                this._nextToken();
                var right = this._parseAdditive();

                var isEquality = opId == TokenId.Equal || opId == TokenId.NotEqual;

                switch (opId) {
                    case TokenId.Equal:
                        left = new BinaryExpression(left, right, ExpressionType.Equal);
                        break;
                    case TokenId.NotEqual:
                        left = new BinaryExpression(left, right, ExpressionType.NotEqual);
                        break;
                    case TokenId.GreaterThan:
                        left = new BinaryExpression(left, right, ExpressionType.GreaterThan);
                        break;
                    case TokenId.GreaterThanEqual:
                        left = new BinaryExpression(left, right, ExpressionType.GreaterThanOrEqual);
                        break;
                    case TokenId.LessThan:
                        left = new BinaryExpression(left, right, ExpressionType.LessThan);
                        break;
                    case TokenId.LessThanEqual:
                        left = new BinaryExpression(left, right, ExpressionType.LessThanOrEqual);
                        break;
                }
            }
            return left;
        },

        // 'add','sub' operators
        _parseAdditive: function () {
            var left = this._parseMultiplicative();
            while (this.token.id == TokenId.Add || this.token.id == TokenId.Sub) {
                var opId = this.token.id;
                this._nextToken();
                var right = this._parseMultiplicative();
                switch (opId) {
                    case TokenId.Add:
                        left = new BinaryExpression(left, right, ExpressionType.Add);
                        break;
                    case TokenId.Sub:
                        left = new BinaryExpression(left, right, ExpressionType.Subtract);
                        break;
                }
            }
            return left;
        },

        // 'mul', 'div', 'mod' operators
        _parseMultiplicative: function () {
            var left = this._parseUnary();
            while (this.token.id == TokenId.Multiply || this.token.id == TokenId.Divide ||
                    this.token.id == TokenId.Modulo) {
                var opId = this.token.id;
                this._nextToken();
                var right = this._parseUnary();
                switch (opId) {
                    case TokenId.Multiply:
                        left = new BinaryExpression(left, right, ExpressionType.Multiply);
                        break;
                    case TokenId.Divide:
                        left = new BinaryExpression(left, right, ExpressionType.Divide);
                        break;
                    case TokenId.Modulo:
                        left = new BinaryExpression(left, right, ExpressionType.Modulo);
                        break;
                }
            }
            return left;
        },

        // -, 'not' unary operators
        _parseUnary: function () {
            if (this.token.id == TokenId.Minus || this.token.id == TokenId.Not) {
                var opId = this.token.id;
                var opPos = this.token.pos;
                this._nextToken();
                if (opId == TokenId.Minus && (this.token.id == TokenId.IntegerLiteral ||
                    this.token.id == TokenId.RealLiteral)) {
                    this.token.text = "-" + this.token.text;
                    this.token.pos = opPos;
                    return this._parsePrimary();
                }
                var expr = this._parseUnary();
                if (opId == TokenId.Minus) {
                    expr = new UnaryExpression(expr, ExpressionType.Negate);
                }
                else {
                    expr = new UnaryExpression(expr, ExpressionType.Not);
                }
                return expr;
            }
            return this._parsePrimary();
        },

        _parsePrimary: function () {
            var expr = this._parsePrimaryStart();
            while (true) {
                if (this.token.id == TokenId.Dot) {
                    this._nextToken();
                    expr = this._parseMemberAccess(expr);
                }
                else {
                    break;
                }
            }
            return expr;
        },

        _parseMemberAccess: function (instance) {
            var errorPos = this.token.pos;
            var id = this._getIdentifier();
            this._nextToken();
            if (this.token.id == TokenId.OpenParen) {
                var mappedFunction = this._mapFunction(id);
                if (mappedFunction !== null) {
                    return this._parseMappedFunction(mappedFunction, errorPos);
                }
                else {
                    throw this._parseError(_.sprintf("Unknown identifier '%s'", id), errorPos);
                }
            }
            else {
                return new MemberExpression(instance, id);
            }
        },

        _parseMappedFunction: function (mappedMember, errorPos) {
            var type = mappedMember.type;
            var mappedMemberName = mappedMember.memberName;
            var args;
            var instance = null;

            this._beginValidateFunction(mappedMemberName, errorPos);

            if (this.token.id == TokenId.OpenParen) {
                args = this._parseArgumentList();

                this._completeValidateFunction(mappedMemberName, args);

                if (mappedMember.mapParams) {
                    mappedMember.mapParams(args);
                }

                // static methods need to include the target
                if (!mappedMember.isStatic) {
                    if (args.length === 0) {
                        throw this._parseError(
                            _.sprintf("No applicable method '%s' exists in type '%s'", mappedMember.memberName, mappedMember.type), errorPos);
                    }

                    instance = args[0];
                    args = args.slice(1);
                }
                else {
                    instance = null;
                }
            }
            else {
                // if it is a function it should begin with a '('
                throw this._parseError("'(' expected");
            }

            if (mappedMember.isMethod) {
                // a mapped function
                return new FunctionCallExpression(instance, mappedMember, args);
            }
            else {
                // a mapped Property/Field
                return new MemberExpression(instance, mappedMember);
            }
        },

        _beginValidateFunction: function (functionName, errorPos) {
            if (functionName === 'replace') {
                // Security: nested calls to replace must be prevented to avoid an exploit
                // wherein the client can force the server to allocate arbitrarily large
                // strings.
                if (this.inStringReplace) {
                    throw this._parseError("Calls to 'replace' cannot be nested.", errorPos);
                }
                this.inStringReplace = true;
            }
        },

        _completeValidateFunction: function (functionName, functionArgs, errorPos) {
            // validate parameters
            switch (functionName) {
                case 'day':
                case 'month':
                case 'year':
                case 'hour':
                case 'minute':
                case 'second':
                case 'floor':
                case 'ceiling':
                case 'round':
                case 'tolower':
                case 'toupper':
                case 'length':
                case 'trim':
                    this._validateFunctionParameters(functionName, functionArgs, 1);
                    break;
                case 'substringof':
                case 'startswith':
                case 'endswith':
                case 'concat':
                case 'indexof':
                    this._validateFunctionParameters(functionName, functionArgs, 2);
                    break;
                case 'replace':
                    this._validateFunctionParameters(functionName, functionArgs, 3);
                    // Security: we limit the replacement value to avoid an exploit
                    // wherein the client can force the server to allocate arbitrarily large
                    // strings. 
                    var replaceArg = functionArgs[2];
                    if ((replaceArg.expressionType !== 'Constant') || (replaceArg.value.length > 100)) {
                        throw this._parseError("The third parameter to 'replace' must be a string constant less than 100 in length.", errorPos);
                    }
                    break;
                case 'substring':
                    if (functionArgs.length != 2 && functionArgs.length != 3) {
                        throw new Error("Function 'substring' requires 2 or 3 parameters.");
                    }
                    break;
            }

            this.inStringReplace = false;
        },

        _validateFunctionParameters: function (functionName, args, expectedArgCount) {
            if (args.length !== expectedArgCount) {
                var error = _.sprintf("Function '%s' requires %d %s",
                    functionName, expectedArgCount, (expectedArgCount > 1) ? "parameters." : "parameter.");
                throw new Error(error);
            }
        },

        _parseArgumentList: function () {
            this._validateToken(TokenId.OpenParen, "'(' expected");
            this._nextToken();
            var args = this.token.id != TokenId.CloseParen ? this._parseArguments() : [];
            this._validateToken(TokenId.CloseParen, "')' or ',' expected");
            this._nextToken();
            return args;
        },

        _parseArguments: function () {
            var args = [];
            while (true) {
                args.push(this._parseExpression());
                if (this.token.id != TokenId.Comma) {
                    break;
                }
                this._nextToken();
            }
            return args;
        },

        _mapFunction: function (functionName) {
            var mappedMember = this._mapStringFunction(functionName);
            if (mappedMember !== null) {
                return mappedMember;
            }

            mappedMember = this._mapDateFunction(functionName);
            if (mappedMember !== null) {
                return mappedMember;
            }

            mappedMember = this._mapMathFunction(functionName);
            if (mappedMember !== null) {
                return mappedMember;
            }

            return null;
        },

        _mapStringFunction: function (functionName) {
            if (functionName == 'startswith') {
                return new MappedMemberInfo('string', functionName, false, true);
            }
            else if (functionName == 'endswith') {
                return new MappedMemberInfo('string', functionName, false, true);
            }
            else if (functionName == 'length') {
                return new MappedMemberInfo('string', functionName, false, false);
            }
            else if (functionName == 'toupper') {
                return new MappedMemberInfo('string', functionName, false, true);
            }
            else if (functionName == 'tolower') {
                return new MappedMemberInfo('string', functionName, false, true);
            }
            else if (functionName == 'trim') {
                return new MappedMemberInfo('string', functionName, false, true);
            }
            else if (functionName == 'substringof') {
                var memberInfo = new MappedMemberInfo('string', functionName, false, true);
                memberInfo.mapParams = function (args) {
                    // reverse the order of arguments for string.Contains
                    var tmp = args[0];
                    args[0] = args[1];
                    args[1] = tmp;
                };
                return memberInfo;
            }
            else if (functionName == 'indexof') {
                return new MappedMemberInfo('string', functionName, false, true);
            }
            else if (functionName == 'replace') {
                return new MappedMemberInfo('string', functionName, false, true);
            }
            else if (functionName == 'substring') {
                return new MappedMemberInfo('string', functionName, false, true);
            }
            else if (functionName == 'trim') {
                return new MappedMemberInfo('string', functionName, false, true);
            }
            else if (functionName == 'concat') {
                return new MappedMemberInfo('string', functionName, true, true);
            }

            return null;
        },

        _mapDateFunction: function (functionName) {
            if (functionName == 'day') {
                return new MappedMemberInfo('date', functionName, false, true);
            }
            else if (functionName == 'month') {
                return new MappedMemberInfo('date', functionName, false, true);
            }
            else if (functionName == 'year') {
                return new MappedMemberInfo('date', functionName, false, true);
            }
            if (functionName == 'hour') {
                return new MappedMemberInfo('date', functionName, false, true);
            }
            else if (functionName == 'minute') {
                return new MappedMemberInfo('date', functionName, false, true);
            }
            else if (functionName == 'second') {
                return new MappedMemberInfo('date', functionName, false, true);
            }
            return null;
        },

        _mapMathFunction: function (functionName) {
            if (functionName == 'floor') {
                return new MappedMemberInfo('math', functionName, false, true);
            }
            else if (functionName == 'ceiling') {
                return new MappedMemberInfo('math', functionName, false, true);
            }
            else if (functionName == 'round') {
                return new MappedMemberInfo('math', functionName, false, true);
            }
            return null;
        },

        _getIdentifier: function () {
            this._validateToken(TokenId.Identifier, 'Identifier expected');
            return this.token.text;
        },

        _parsePrimaryStart: function () {
            switch (this.token.id) {
                case TokenId.Identifier:
                    return this._parseIdentifier();
                case TokenId.StringLiteral:
                    return this._parseStringLiteral();
                case TokenId.IntegerLiteral:
                    return this._parseIntegerLiteral();
                case TokenId.RealLiteral:
                    return this._parseRealLiteral();
                case TokenId.OpenParen:
                    return this._parseParenExpression();
                default:
                    throw this._parseError('Expression expected');
            }
        },

        _parseIntegerLiteral: function () {
            this._validateToken(TokenId.IntegerLiteral);
            var text = this.token.text;

            // parseInt will return the integer portion of the string, and won't
            // error on something like '1234xyz'.
            var value = parseInt(text, 10);
            if (isNaN(value) || (value != text)) {
                throw this._parseError(_.sprintf("Invalid integer literal '%s'", text));
            }

            this._nextToken();
            if (this.token.text.toUpperCase() == 'L') {
                // in JS there is only one type of integer number, so this code is only here
                // to parse the OData 'L/l' correctly
                this._nextToken();
                return new ConstantExpression(value);
            }
            return new ConstantExpression(value);
        },

        _parseRealLiteral: function () {
            this._validateToken(TokenId.RealLiteral);
            var text = this.token.text;

            var last = text.slice(-1);
            if (last.toUpperCase() == 'F' || last.toUpperCase() == 'M' || last.toUpperCase() == 'D') {
                // in JS there is only one floating point type,
                // so terminating F/f, M/m, D/d have no effect.
                text = text.slice(0, -1);
            }

            var value = parseFloat(text);
            if (isNaN(value) || (value != text)) {
                throw this._parseError(_.sprintf("Invalid real literal '%s'", text));
            }

            this._nextToken();
            return new ConstantExpression(value);
        },

        _parseParenExpression: function () {
            this._validateToken(TokenId.OpenParen, "'(' expected");
            this._nextToken();
            var e = this._parseExpression();
            this._validateToken(TokenId.CloseParen, "')' or operator expected");
            this._nextToken();
            return e;
        },

        _parseIdentifier: function () {
            this._validateToken(TokenId.Identifier);
            var value = this.keywords[this.token.text];
            if (value) {
                // type construction has the format of type'value' e.g. datetime'2001-04-01T00:00:00Z'
                // therefore if the next character is a single quote then we try to 
                // interpret this as type construction else its a normal member access
                if (typeof value === 'string' && this.ch == '\'') {
                    return this._parseTypeConstruction(value);
                }
                else if (typeof value !== 'string') {  // this is a constant
                    this._nextToken();
                    return value;
                }
            }

            if (this.it !== null) {
                return this._parseMemberAccess(this.it);
            }

            throw this._parseError(_.sprintf("Unknown identifier '%s'", this.token.text));
        },

        _parseTypeConstruction: function (type) {
            var typeIdentifier = this.token.text;
            var errorPos = this.token.pos;
            this._nextToken();
            var typeExpression = null;

            if (this.token.id == TokenId.StringLiteral) {
                errorPos = this.token.pos;
                var stringExpr = this._parseStringLiteral();
                var literalValue = stringExpr.value;
                var date = null;

                try {
                    if (type == 'datetime') {
                        date = core.parseISODate(literalValue);
                        if (date) {
                            typeExpression = new ConstantExpression(date);
                        }
                    }
                    else if (type == 'datetimeoffset') {
                        date = core.parseDateTimeOffset(literalValue);
                        if (date) {
                            typeExpression = new ConstantExpression(date);
                        }
                    }
                }
                catch (e) {
                    throw this._parseError(e, errorPos);
                }
            }

            if (!typeExpression) {
                throw this._parseError(_.sprintf("Invalid '%s' type creation expression", typeIdentifier), errorPos);
            }

            return typeExpression;
        },

        _parseStringLiteral: function () {
            this._validateToken(TokenId.StringLiteral);
            var quote = this.token.text[0];
            // Unwrap string (remove surrounding quotes) and unwrap escaped quotes.
            var s = this.token.text.substr(1, this.token.text.length - 2).replace(/''/g, "'");

            this._nextToken();
            return new ConstantExpression(s);
        },

        _validateToken: function (tokenId, error) {
            if (this.token.id != tokenId) {
                throw this._parseError(error || 'Syntax error');
            }
        },

        _createKeywords: function () {
            return {
                "true": new ConstantExpression(true),
                "false": new ConstantExpression(false),
                "null": new ConstantExpression(null),

                // type keywords
                datetime: 'datetime',
                datetimeoffset: 'datetimeoffset'
            };
        },

        _setTextPos: function (pos) {
            this.textPos = pos;
            this.ch = this.textPos < this.textLen ? this.text[this.textPos] : '\\0';
        },

        _nextToken: function () {
            while (this._isWhiteSpace(this.ch)) {
                this._nextChar();
            }
            var t; // TokenId
            var tokenPos = this.textPos;
            switch (this.ch) {
                case '(':
                    this._nextChar();
                    t = TokenId.OpenParen;
                    break;
                case ')':
                    this._nextChar();
                    t = TokenId.CloseParen;
                    break;
                case ',':
                    this._nextChar();
                    t = TokenId.Comma;
                    break;
                case '-':
                    this._nextChar();
                    t = TokenId.Minus;
                    break;
                case '/':
                    this._nextChar();
                    t = TokenId.Dot;
                    break;
                case '\'':
                    var quote = this.ch;
                    do {
                        this._nextChar();
                        while (this.textPos < this.textLen && this.ch != quote) {
                            this._nextChar();
                        }

                        if (this.textPos == this.textLen) {
                            throw this._parseError("Unterminated string literal", this.textPos);
                        }
                        this._nextChar();
                    }
                    while (this.ch == quote);
                    t = TokenId.StringLiteral;
                    break;
                default:
                    if (this._isIdentifierStart(this.ch) || this.ch == '@' || this.ch == '_') {
                        do {
                            this._nextChar();
                        }
                        while (this._isIdentifierPart(this.ch) || this.ch == '_');
                        t = TokenId.Identifier;
                        break;
                    }
                    if (core.isDigit(this.ch)) {
                        t = TokenId.IntegerLiteral;
                        do {
                            this._nextChar();
                        }
                        while (core.isDigit(this.ch));
                        if (this.ch == '.') {
                            t = TokenId.RealLiteral;
                            this._nextChar();
                            this._validateDigit();
                            do {
                                this._nextChar();
                            }
                            while (core.isDigit(this.ch));
                        }
                        if (this.ch == 'E' || this.ch == 'e') {
                            t = TokenId.RealLiteral;
                            this._nextChar();
                            if (this.ch == '+' || this.ch == '-') {
                                this._nextChar();
                            }
                            this._validateDigit();
                            do {
                                this._nextChar();
                            }
                            while (core.isDigit(this.ch));
                        }
                        if (this.ch == 'F' || this.ch == 'f' || this.ch == 'M' || this.ch == 'm' || this.ch == 'D' || this.ch == 'd') {
                            t = TokenId.RealLiteral;
                            this._nextChar();
                        }
                        break;
                    }
                    if (this.textPos == this.textLen) {
                        t = TokenId.End;
                        break;
                    }
                    throw this._parseError("Syntax error '" + this.ch + "'", this.textPos);
            }
            this.token.id = t;
            this.token.text = this.text.substr(tokenPos, this.textPos - tokenPos);
            this.token.pos = tokenPos;

            this.token.id = this._reclassifyToken(this.token);
        },

        _reclassifyToken: function (token) {
            if (token.id == TokenId.Identifier) {
                if (token.text == "or") {
                    return TokenId.Or;
                }
                else if (token.text == "add") {
                    return TokenId.Add;
                }
                else if (token.text == "and") {
                    return TokenId.And;
                }
                else if (token.text == "div") {
                    return TokenId.Divide;
                }
                else if (token.text == "sub") {
                    return TokenId.Sub;
                }
                else if (token.text == "mul") {
                    return TokenId.Multiply;
                }
                else if (token.text == "mod") {
                    return TokenId.Modulo;
                }
                else if (token.text == "ne") {
                    return TokenId.NotEqual;
                }
                else if (token.text == "not") {
                    return TokenId.Not;
                }
                else if (token.text == "le") {
                    return TokenId.LessThanEqual;
                }
                else if (token.text == "lt") {
                    return TokenId.LessThan;
                }
                else if (token.text == "eq") {
                    return TokenId.Equal;
                }
                else if (token.text == "ge") {
                    return TokenId.GreaterThanEqual;
                }
                else if (token.text == "gt") {
                    return TokenId.GreaterThan;
                }
            }

            return token.id;
        },

        _nextChar: function () {
            if (this.textPos < this.textLen) {
                this.textPos++;
            }
            this.ch = this.textPos < this.textLen ? this.text[this.textPos] : '\\0';
        },

        _isWhiteSpace: function (ch) {
            return (/\s/).test(ch);
        },

        _validateDigit: function () {
            if (!core.isDigit(this.ch)) {
                throw this._parseError('Digit expected', this.textPos);
            }
        },

        _parseError: function (error, pos) {
            pos = pos || this.token.pos || 0;
            return new Error(error + ' (at index ' + pos + ')');
        },

        _isIdentifierStart: function (ch) {
            return core.isLetter(ch);
        },

        _isIdentifierPart: function (ch) {
            if (this._isIdentifierStart(ch)) {
                return true;
            }

            if (core.isDigit(ch)) {
                return true;
            }

            if (ch == '_' || ch == '-') {
                return true;
            }

            return false;
        }
    };

    QueryParser = core.defineClass(ctor, instanceMembers, classMembers);

})(typeof exports === "undefined" ? this : exports);