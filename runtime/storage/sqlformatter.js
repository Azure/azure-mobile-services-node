// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------

((global => {
    var core = require('../core');
    var _ = require('underscore');
    var _str = require('underscore.string');

    require('../query/expressions');
    require('../query/expressionvisitor');
    require('../query/queryparser');
    require('./sqlbooleanizer');
    require('./typeconverter');
    require('./sqlhelpers');

    _.mixin(_str.exports());

    var ctor = function (schemaName, tableMetadata) {
        this.schemaName = schemaName;
        this.tableMetadata = tableMetadata;
    };

    var instanceMembers = {

        format(query) {
            this.sql = '';
            this.paramNumber = 0;
            this.parameters = [];
            
            // if a skip is requested but no top is defined, we need
            // to still generate the paging query, so default top to
            // max. Really when doing paging, the user should also be
            // specifying a top explicitly however.
            if (query.skip > 0 && query.top === undefined) {
                query.top = core.MAX_INT;
            }

            if (query.skip >= 0 && query.top >= 0) {
                this.sql = this._formatPagedQuery(query);
            }
            else {
                this.sql = this._formatQuery(query);
            }

            this.sql = this.sql.trim();
        },

        _formatQuery(query) {
            var formattedSql;

            var selection = query.select ? this._formatSelection(query.select, query.systemProperties) : '*';

            // set the top clause to be the minimumn of the top
            // and result limit values if either has been set.
            var top = '';
            var limit = -1;
            var resultLimit = query.resultLimit || Number.MAX_VALUE;
            if (query.top >= 0) {
                limit = Math.min(resultLimit, query.top);
            }
            else if (resultLimit != Number.MAX_VALUE) {
                limit = query.resultLimit;
            }
            if (limit != -1) {
                top = 'TOP ' + limit.toString() + ' ';
            }

            var filter = this._formatFilter(query);
            var order = this._formatOrderBy(query);

            var tableName = SqlHelpers.formatTableName(this.schemaName, query.table);
            formattedSql = _.sprintf("SELECT %s%s FROM %s", top, selection, tableName);
            if (filter.length > 0) {
                formattedSql += ' WHERE ' + filter;
            }
            if (order.length > 0) {
                formattedSql += ' ORDER BY ' + order;
            }

            if (query.inlineCount === 'allpages') {
                formattedSql += '; ' + this._formatCountQuery(tableName, query);
            }

            return formattedSql;
        },

        _formatPagedQuery(query) {
            var formattedSql;
            var selection = '';
            var aliasedSelection = '';

            if (query.select) {
                selection = this._formatSelection(query.select, query.systemProperties);
                aliasedSelection = '[t1].[ROW_NUMBER], ' + this._formatSelection(query.select, query.systemProperties, '[t1].');
            }
            else {
                selection = aliasedSelection = "*";
            }

            var filter = this._formatFilter(query, '(1 = 1)');
            var order = this._formatOrderBy(query, '[id]');

            // Plug all the pieces into the template to get the paging sql
            var tableName = SqlHelpers.formatTableName(this.schemaName, query.table);
            formattedSql = _.sprintf(
                "SELECT %s FROM (SELECT ROW_NUMBER() OVER (ORDER BY %s) AS [ROW_NUMBER], %s " +
                "FROM %s WHERE %s) AS [t1] " +
                "WHERE [t1].[ROW_NUMBER] BETWEEN %d + 1 AND %d + %d " +
                "ORDER BY [t1].[ROW_NUMBER]",
                aliasedSelection, order, selection, tableName, filter, query.skip, query.skip, query.top);

            if (query.inlineCount === 'allpages') {
                formattedSql += '; ' + this._formatCountQuery(tableName, query);
            }

            return formattedSql;
        },

        _formatCountQuery(table, query) {
            var filter;

            if (query.filter || query.id !== undefined || this.tableMetadata.supportsSoftDelete) {
                this.sql = '';
                filter = this._formatFilter(query);
            }

            var sql = 'SELECT COUNT(*) AS [count] FROM ' + table;
            if (filter) {
                sql += ' WHERE ' + filter;
            }
            return sql;
        },

        _formatOrderBy(query, defaultOrder) {
            var orderBy = query.orderBy;

            if (!orderBy) {
                return defaultOrder || '';
            }

            // if we already have a parsed orderby, us it,
            // otherwise parse the orderby
            var orderings;
            if (query._parsed && query._parsed.orderBy) {
                orderings = query._parsed.orderBy;
            }
            else {
                orderings = QueryParser.orderBy(orderBy);
            }

            var order = '';
            var self = this;
            orderings.forEach(ordering => {
                if (order.length > 0) {
                    order += ', ';
                }
                self.sql = '';
                self.visit(ordering.selector);
                if (!ordering.ascending) {
                    self.sql += ' DESC';
                }
                order += self.sql;
            });

            return order;
        },

        _formatSelection(selection, systemProperties, prefix) {
            systemProperties = (systemProperties || []).map(core.systemPropertyToColumnName);

            var formattedSelection = '';
            var columns = selection.split(',').concat(systemProperties);

            columns.forEach(column => {
                var member = column.trim();
                if (formattedSelection.length > 0) {
                    formattedSelection += ', ';
                }
                formattedSelection += (prefix || '') + SqlHelpers.formatMember(member);
            });

            return formattedSelection;
        },

        _formatFilter(query, defaultFilter) {
            // if we already have a parsed filter use it,
            // otherwise parse the filter
            var filterExpr;
            if (query._parsed && query._parsed.filter) {
                filterExpr = query._parsed.filter;
            }
            else if (query.filter && query.filter.length > 0) {
                filterExpr = QueryParser.filter(query.filter);
            }

            if (query.id !== undefined) {
                var id = this.tableMetadata.hasStringId ? "'" + query.id.replace(/'/g, "''") + "'" : query.id;
                var idFilterExpr = QueryParser.filter(_.sprintf('(id eq %s)', id));

                // append the id filter to any existing filter
                if (filterExpr) {
                    filterExpr = new BinaryExpression(filterExpr, idFilterExpr, ExpressionType.And);
                }
                else {
                    filterExpr = idFilterExpr;
                }
            }

            // if soft delete is enabled filter out deleted records
            if (this.tableMetadata.supportsSoftDelete && !query.includeDeleted) {
                var deletedFilter = QueryParser.filter(_.sprintf('(__deleted eq false)'));
                if (filterExpr) {
                    filterExpr = new BinaryExpression(filterExpr, deletedFilter, ExpressionType.And);
                }
                else {
                    filterExpr = deletedFilter;
                }
            }

            if (!filterExpr) {
                return defaultFilter || '';
            }

            this.sql = '';
            filterExpr = this._finalizeExpression(filterExpr);
            this.visit(filterExpr);

            return this.sql;
        },

        // run the final query translation pipeline on the specified
        // expression, modifying the expression tree as needed
        _finalizeExpression(expr) {
            expr = SqlBooleanizer.booleanize(expr);
            expr = TypeConverter.convertTypes(expr, this.tableMetadata);
            return expr;
        },

        visitBinary(expr) {
            this.sql += '(';

            var left = null;
            var right = null;

            // modulo requires the dividend to be an integer, monetary or numeric
            // rewrite the expression to convert to numeric, allowing the DB to apply
            // rounding if needed. our default data type for number is float which
            // is incompatible with modulo.
            if (expr.expressionType == ExpressionType.Modulo) {
                expr.left = new ConvertExpression('numeric', expr.left);
            }

            if (expr.left) {
                left = this.visit(expr.left);
            }

            if (expr.right && (expr.right.value === null)) {
                // inequality expressions against a null literal have a special
                // translation in SQL
                if (expr.expressionType == ExpressionType.Equal) {
                    this.sql += ' IS NULL';
                }
                else if (expr.expressionType == ExpressionType.NotEqual) {
                    this.sql += ' IS NOT NULL';
                }
            }
            else {
                switch (expr.expressionType) {
                    case ExpressionType.Equal:
                        this.sql += ' = ';
                        break;
                    case ExpressionType.NotEqual:
                        this.sql += ' != ';
                        break;
                    case ExpressionType.LessThan:
                        this.sql += ' < ';
                        break;
                    case ExpressionType.LessThanOrEqual:
                        this.sql += ' <= ';
                        break;
                    case ExpressionType.GreaterThan:
                        this.sql += ' > ';
                        break;
                    case ExpressionType.GreaterThanOrEqual:
                        this.sql += ' >= ';
                        break;
                    case ExpressionType.And:
                        this.sql += ' AND ';
                        break;
                    case ExpressionType.Or:
                        this.sql += ' OR ';
                        break;
                    case ExpressionType.Add:
                        this.sql += ' + ';
                        break;
                    case ExpressionType.Subtract:
                        this.sql += ' - ';
                        break;
                    case ExpressionType.Multiply:
                        this.sql += ' * ';
                        break;
                    case ExpressionType.Divide:
                        this.sql += ' / ';
                        break;
                    case ExpressionType.Modulo:
                        this.sql += ' % ';
                        break;
                }

                if (expr.right) {
                    right = this.visit(expr.right);
                }
            }

            this.sql += ')';

            if ((left !== expr.left) || (right !== expr.right)) {
                return new BinaryExpression(left, right);
            }

            return expr;
        },

        visitConstant(expr) {
            if (expr.value === null) {
                this.sql += 'NULL';
                return expr;
            }

            this.sql += this._createParameter(expr.value);

            return expr;
        },

        _createParameter(value) {
            var parameter = {
                name: '@p' + (this.paramNumber++).toString(),
                pos: this.paramNumber,
                value
            };

            this.parameters.push(parameter);

            // TODO: maintaining the above named parameter code for now
            // for when the sql driver supports them.
            return '?';
        },

        visitMember(expr) {
            if (typeof expr.member === 'string') {
                this.sql += SqlHelpers.formatMember(expr.member);
            }
            else {
                this._formatMappedMember(expr);
            }

            return expr;
        },

        visitUnary(expr) {
            if (expr.expressionType == ExpressionType.Not) {
                this.sql += 'NOT ';
                this.visit(expr.operand);
            }
            else if (expr.expressionType == ExpressionType.Convert) {
                this.sql += _.sprintf("CONVERT(%s, ", expr.desiredType);
                this.visit(expr.operand);
                this.sql += ')';
            }

            return expr;
        },

        visitFunction(expr) {
            if (expr.memberInfo) {
                this._formatMappedFunction(expr);
            }
            return expr;
        },

        _formatMappedFunction(expr) {
            if (expr.memberInfo.type == 'string') {
                this._formatMappedStringMember(expr.instance, expr.memberInfo, expr.args);
            }
            else if (expr.memberInfo.type == 'date') {
                this._formatMappedDateMember(expr.instance, expr.memberInfo, expr.args);
            }
            else if (expr.memberInfo.type == 'math') {
                this._formatMappedMathMember(expr.instance, expr.memberInfo, expr.args);
            }
        },

        _formatMappedMember(expr) {
            if (expr.member.type == 'string') {
                this._formatMappedStringMember(expr.instance, expr.member, null);
            }
        },

        _formatMappedDateMember(instance, mappedMemberInfo, args) {
            var functionName = mappedMemberInfo.memberName;

            if (functionName == 'day') {
                this.sql += 'DAY(';
                this.visit(instance);
                this.sql += ')';
            }
            else if (mappedMemberInfo.memberName == 'month') {
                this.sql += 'MONTH(';
                this.visit(instance);
                this.sql += ')';
            }
            else if (mappedMemberInfo.memberName == 'year') {
                this.sql += 'YEAR(';
                this.visit(instance);
                this.sql += ')';
            }
            else if (mappedMemberInfo.memberName == 'hour') {
                this.sql += 'DATEPART(HOUR, ';
                this.visit(instance);
                this.sql += ')';
            }
            else if (mappedMemberInfo.memberName == 'minute') {
                this.sql += 'DATEPART(MINUTE, ';
                this.visit(instance);
                this.sql += ')';
            }
            else if (mappedMemberInfo.memberName == 'second') {
                this.sql += 'DATEPART(SECOND, ';
                this.visit(instance);
                this.sql += ')';
            }
        },

        _formatMappedMathMember(instance, mappedMemberInfo, args) {
            var functionName = mappedMemberInfo.memberName;

            if (functionName == 'floor') {
                this.sql += 'FLOOR(';
                this.visit(instance);
                this.sql += ')';
            }
            else if (functionName == 'ceiling') {
                this.sql += 'CEILING(';
                this.visit(instance);
                this.sql += ')';
            }
            else if (functionName == 'round') {
                // Use the 'away from zero' midpoint rounding strategy - when
                // a number is halfway between two others, it is rounded toward
                // the nearest number that is away from zero.
                this.sql += 'ROUND(';
                this.visit(instance);
                this.sql += ', 0)';
            }
        },

        _formatMappedStringMember(instance, mappedMemberInfo, args) {
            var functionName = mappedMemberInfo.memberName;

            if (functionName == 'substringof') {
                this.sql += '(';
                this.visit(instance);

                this.sql += ' LIKE ';

                // form '%' + <arg> + '%'
                this.sql += "('%' + ";
                this.visit(args[0]);
                this.sql += " + '%')";

                this.sql += ')';
            }
            else if (functionName == 'startswith') {
                this.sql += '(';
                this.visit(instance);

                this.sql += ' LIKE ';

                // form '<arg> + '%'
                this.sql += '(';
                this.visit(args[0]);
                this.sql += " + '%')";

                this.sql += ')';
            }
            else if (functionName == 'endswith') {
                this.sql += '(';
                this.visit(instance);

                this.sql += ' LIKE ';

                // form '%' + '<arg>
                this.sql += "('%' + ";
                this.visit(args[0]);
                this.sql += ')';

                this.sql += ')';
            }
            else if (functionName == 'concat') {
                // Rewrite as an string addition with appropriate conversions.
                // Note: due to sql operator precidence, we only need to inject a
                // single conversion - the other will be upcast to string.
                if (!isConstantOfType(args[0], 'string')) {
                    args[0] = new ConvertExpression(SqlHelpers.getSqlType(''), args[0]);
                } else if (!isConstantOfType(args[1], 'string')) {
                    args[1] = new ConvertExpression(SqlHelpers.getSqlType(''), args[1]);
                }
                var concat = new BinaryExpression(args[0], args[1], ExpressionType.Add);
                this.visit(concat);
            }
            else if (functionName == 'tolower') {
                this.sql += 'LOWER(';
                this.visit(instance);
                this.sql += ')';
            }
            else if (functionName == 'toupper') {
                this.sql += 'UPPER(';
                this.visit(instance);
                this.sql += ')';
            }
            else if (functionName == 'length') {
                // special translation since SQL LEN function doesn't
                // preserve trailing spaces
                this.sql += '(LEN(';
                this.visit(instance);
                this.sql += " + 'X') - 1)";
            }
            else if (functionName == 'trim') {
                this.sql += 'LTRIM(RTRIM(';
                this.visit(instance);
                this.sql += '))';
            }
            else if (functionName == 'indexof') {
                this.sql += "(PATINDEX('%' + ";
                this.visit(args[0]);
                this.sql += " + '%', ";
                this.visit(instance);
                this.sql += ') - 1)';
            }
            else if (functionName == 'replace') {
                this.sql += "REPLACE(";
                this.visit(instance);
                this.sql += ", ";
                this.visit(args[0]);
                this.sql += ", ";
                this.visit(args[1]);
                this.sql += ')';
            }
            else if (functionName == 'substring') {
                this.sql += 'SUBSTRING(';
                this.visit(instance);

                this.sql += ", ";
                this.visit(args[0]);
                this.sql += " + 1, ";  // need to add 1 since SQL is 1 based, but OData is zero based

                if (args.length == 1) {
                    // Overload not taking an explicit length. The
                    // LEN of the entire expression is used in this case
                    // which means everything after the start index will
                    // be taken. 
                    this.sql += 'LEN(';
                    this.visit(instance);
                    this.sql += ')';
                }
                else if (args.length == 2) {
                    // overload taking a length
                    this.visit(args[1]);
                }

                this.sql += ')';
            }
        }
    };

    function isConstantOfType(expr, type) {
        return (expr.expressionType == ExpressionType.Constant) && (typeof expr.value === type);
    }

    SqlFormatter = core.deriveClass(ExpressionVisitor, ctor, instanceMembers);
}))(typeof exports === "undefined" ? this : exports);