// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------

(function (global) {

    var core = require('../core');

    ExpressionType = {
        Constant: 'Constant',
        Add: 'Add',
        And: 'And',
        Divide: 'Divide',
        Equal: 'Equal',
        GreaterThan: 'GreaterThan',
        GreaterThanOrEqual: 'GreaterThanOrEqual',
        LessThan: 'LessThan',
        LessThanOrEqual: 'LessThanOrEqual',
        MemberAccess: 'MemberAccess',
        Modulo: 'Modulo',
        Multiply: 'Multiply',
        Negate: 'Negate',
        Not: 'Not',
        NotEqual: 'NotEqual',
        Or: 'Or',
        Parameter: 'Parameter',
        Subtract: 'Subtract',
        Call: 'Call',
        Convert: 'Convert'
    };

    MappedMemberInfo = core.defineClass(
    function (type, memberName, isStatic, isMethod) {
        this.type = type;
        this.memberName = memberName;
        this.isStatic = isStatic;
        this.isMethod = isMethod;
    }, null, null);

    Expression = core.defineClass(
    null, {
        accept: function (visitor) {
            return visitor.visit(this);
        }
    },
    null);

    ConstantExpression = core.deriveClass(
    Expression,
    function (value) {
        this.value = value;
        this.expressionType = ExpressionType.Constant;
    }, {
        accept: function (visitor) {
            return visitor.visitConstant(this);
        }
    },
    null);

    BinaryExpression = core.deriveClass(
    Expression,
    function (left, right, expressionType) {
        this.left = left;
        this.right = right;
        this.expressionType = expressionType;
    }, {
        accept: function (visitor) {
            return visitor.visitBinary(this);
        }
    },
    null);

    UnaryExpression = core.deriveClass(
    Expression,
    function (operand, expressionType) {
        this.operand = operand;
        this.expressionType = expressionType;
    }, {
        accept: function (visitor) {
            return visitor.visitUnary(this);
        }
    },
    null);

    MemberExpression = core.deriveClass(
    Expression,
    // member may be either a member name or a MappedMemberInfo
    function (instance, member) {
        this.instance = instance;
        this.member = member;
        this.expressionType = ExpressionType.MemberAccess;
    }, {
        accept: function (visitor) {
            return visitor.visitMember(this);
        }
    },
    null);

    FunctionCallExpression = core.deriveClass(
    Expression,
    function (instance, memberInfo, args) {
        this.instance = instance;
        this.memberInfo = memberInfo;
        this.args = args;
        this.expressionType = ExpressionType.Call;
    }, {
        accept: function (visitor) {
            return visitor.visitFunction(this);
        }
    },
    null);

    ParameterExpression = core.defineClass(
    function () {
        this.ExpressionType = ExpressionType.Parameter;
    }, {
        accept: function (visitor) {
            return visitor.visitParameter(this);
        }
    },
    null);

    ConvertExpression = core.deriveClass(
    Expression,
    function (desiredType, operand) {
        this.desiredType = desiredType;
        this.operand = operand;
        this.expressionType = ExpressionType.Convert;
    }, {
        accept: function (visitor) {
            return visitor.visitUnary(this);
        }
    },
    null);

})(typeof exports === "undefined" ? this : exports);