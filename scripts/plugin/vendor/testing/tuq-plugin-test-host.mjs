var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key4 in object) {
      if (Object.prototype.hasOwnProperty.call(object, key4)) {
        keys.push(key4);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage2 = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage2 = map(fullIssue, { data, defaultError: errorMessage2 }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage2
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      ctx.schemaErrorMap,
      overrideMap,
      overrideMap === en_default ? void 0 : en_default
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key4 = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key: key4,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key: key4, value } = pair;
      if (key4.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key4.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key4.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key4.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

var ParseInputLazyPath = class {
  constructor(parent, value, path, key4) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key4;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err2) {
        if (err2?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version2) {
  if ((version2 === "v4" || !version2) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version2 === "v6" || !version2) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version2) {
  if ((version2 === "v4" || !version2) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version2 === "v6" || !version2) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key4 in schema.shape) {
      const fieldSchema = schema.shape[key4];
      newShape[key4] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key4 in ctx.data) {
        if (!shapeKeys.includes(key4)) {
          extraKeys.push(key4);
        }
      }
    }
    const pairs = [];
    for (const key4 of shapeKeys) {
      const keyValidator = shape[key4];
      const value = ctx.data[key4];
      pairs.push({
        key: { status: "valid", value: key4 },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key4)),
        alwaysSet: key4 in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key4 of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key4 },
            value: { status: "valid", value: ctx.data[key4] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key4 of extraKeys) {
        const value = ctx.data[key4];
        pairs.push({
          key: { status: "valid", value: key4 },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key4)
          ),
          alwaysSet: key4 in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key4 = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key: key4,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  setKey(key4, schema) {
    return this.augment({ [key4]: schema });
  }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key4 of util.objectKeys(mask)) {
      if (mask[key4] && this.shape[key4]) {
        shape[key4] = this.shape[key4];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key4 of util.objectKeys(this.shape)) {
      if (!mask[key4]) {
        shape[key4] = this.shape[key4];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key4 of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key4];
      if (mask && !mask[key4]) {
        newShape[key4] = fieldSchema;
      } else {
        newShape[key4] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key4 of util.objectKeys(this.shape)) {
      if (mask && !mask[key4]) {
        newShape[key4] = this.shape[key4];
      } else {
        const fieldSchema = this.shape[key4];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key4] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type2) => {
  if (type2 instanceof ZodLazy) {
    return getDiscriminator(type2.schema);
  } else if (type2 instanceof ZodEffects) {
    return getDiscriminator(type2.innerType());
  } else if (type2 instanceof ZodLiteral) {
    return [type2.value];
  } else if (type2 instanceof ZodEnum) {
    return type2.options;
  } else if (type2 instanceof ZodNativeEnum) {
    return util.objectValues(type2.enum);
  } else if (type2 instanceof ZodDefault) {
    return getDiscriminator(type2._def.innerType);
  } else if (type2 instanceof ZodUndefined) {
    return [void 0];
  } else if (type2 instanceof ZodNull) {
    return [null];
  } else if (type2 instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type2.unwrap())];
  } else if (type2 instanceof ZodNullable) {
    return [null, ...getDiscriminator(type2.unwrap())];
  } else if (type2 instanceof ZodBranded) {
    return getDiscriminator(type2.unwrap());
  } else if (type2 instanceof ZodReadonly) {
    return getDiscriminator(type2.unwrap());
  } else if (type2 instanceof ZodCatch) {
    return getDiscriminator(type2._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type2 of options) {
      const discriminatorValues = getDiscriminator(type2.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type2);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key4) => bKeys.indexOf(key4) !== -1);
    const newObj = { ...a, ...b };
    for (const key4 of sharedKeys) {
      const sharedValue = mergeValues(a[key4], b[key4]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key4] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key4 in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key4, ctx.path, key4)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key4], ctx.path, key4)),
        alwaysSet: key4 in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key4, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key4, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key4 = await pair.key;
          const value = await pair.value;
          if (key4.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key4.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key4.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key4 = pair.key;
        const value = pair.value;
        if (key4.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key4.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key4.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size2, message) {
    return this.min(size2, message).max(size2, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type2, params) => {
  return new ZodOptional({
    innerType: type2,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type2, params) => {
  return new ZodNullable({
    innerType: type2,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type2, params) => {
  return new ZodDefault({
    innerType: type2,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type2, params) => {
  return new ZodCatch({
    innerType: type2,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type2, params) => {
  return new ZodReadonly({
    innerType: type2,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: (arg) => ZodString.create({ ...arg, coerce: true }),
  number: (arg) => ZodNumber.create({ ...arg, coerce: true }),
  boolean: (arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  }),
  bigint: (arg) => ZodBigInt.create({ ...arg, coerce: true }),
  date: (arg) => ZodDate.create({ ...arg, coerce: true })
};
var NEVER = INVALID;

var PLUGIN_MANIFEST_SCHEMA_VERSION = 1;
var PLUGIN_RUNTIME_PROTOCOL_VERSION = 1;
var IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
var CAPABILITY_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*@[1-9][0-9]*$/;
var PERMISSION_PATTERN = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*){1,3}$/;
var VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
var RANGE_PATTERN = /^(?:\^|>=)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
var unique = (values) => new Set(values).size === values.length;
var PluginManifestV1Schema = external_exports.object({
  schemaVersion: external_exports.literal(PLUGIN_MANIFEST_SCHEMA_VERSION),
  id: external_exports.string().min(3).max(96).regex(IDENTIFIER_PATTERN),
  name: external_exports.string().min(1).max(96),
  version: external_exports.string().regex(VERSION_PATTERN),
  pluginApi: external_exports.string().regex(RANGE_PATTERN),
  minCoreVersion: external_exports.string().regex(RANGE_PATTERN),
  capabilities: external_exports.array(external_exports.string().regex(CAPABILITY_PATTERN)).max(32),
  requiredCapabilities: external_exports.array(external_exports.string().regex(CAPABILITY_PATTERN)).max(32),
  permissions: external_exports.array(external_exports.string().regex(PERMISSION_PATTERN)).max(64)
}).strict().superRefine((value, context) => {
  for (const [field, values] of [
    ["capabilities", value.capabilities],
    ["requiredCapabilities", value.requiredCapabilities],
    ["permissions", value.permissions]
  ]) {
    if (!unique(values)) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: [field], message: `${field} must not contain duplicates` });
  }
});
var PLUGIN_LIFECYCLE_STATES = ["REGISTERED", "ACTIVATING", "READY", "DEACTIVATING", "INACTIVE", "DISABLED", "FAILED", "NEEDS_ASSETS", "BLOCKED_DEPENDENCY"];
var CAPABILITY_DEPENDENCY_STATUSES = ["available", "provider_not_ready", "provider_not_allowed", "unresolved"];
var PLUGIN_SIGNER_KINDS = ["teamuq", "dev", "unsigned"];
var PluginRuntimeSnapshotRequestV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION)
}).strict();
var PluginRuntimeSetEnabledRequestV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION),
  pluginId: external_exports.string().regex(IDENTIFIER_PATTERN),
  enabled: external_exports.boolean()
}).strict();
var PluginRuntimeReactivateRequestV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION),
  pluginId: external_exports.string().regex(IDENTIFIER_PATTERN)
}).strict();
var PluginViewDeclarationV1Schema = external_exports.object({
  id: external_exports.string().regex(IDENTIFIER_PATTERN).max(32),
  title: external_exports.string().min(1).max(48),
  presentations: external_exports.array(external_exports.enum(["tab", "window", "fullpage", "overlay", "settings"])).min(1).max(5),
  defaultPresentation: external_exports.enum(["tab", "window", "fullpage", "overlay", "settings"])
}).strict();
var PluginDependencyProviderV1Schema = external_exports.object({
  id: external_exports.string().regex(IDENTIFIER_PATTERN),
  version: external_exports.string().regex(VERSION_PATTERN),
  name: external_exports.string().max(96),
  signer: external_exports.enum(PLUGIN_SIGNER_KINDS),
  state: external_exports.enum(PLUGIN_LIFECYCLE_STATES),
  allowed: external_exports.boolean(),
  selected: external_exports.boolean()
}).strict();
var PluginDependencyStatusV1Schema = external_exports.object({
  capability: external_exports.string().regex(CAPABILITY_PATTERN),
  required: external_exports.boolean(),
  status: external_exports.enum(CAPABILITY_DEPENDENCY_STATUSES),
  providers: external_exports.array(PluginDependencyProviderV1Schema).max(16)
}).strict();
var PluginRuntimeEntrySnapshotV1Schema = external_exports.object({
  id: external_exports.string().regex(IDENTIFIER_PATTERN),
  version: external_exports.string().regex(VERSION_PATTERN),
  enabled: external_exports.boolean(),
  state: external_exports.enum(PLUGIN_LIFECYCLE_STATES),
  health: external_exports.enum(["ready", "failed", "unknown"]),
  capabilities: external_exports.array(external_exports.string().regex(CAPABILITY_PATTERN)),
  permissions: external_exports.array(external_exports.string().regex(PERMISSION_PATTERN)),
  revision: external_exports.number().int().nonnegative(),
  errorCode: external_exports.string().min(1).max(96).nullable(),
  iconDataUrl: external_exports.string().max(Math.ceil(64 * 1024 / 3) * 4 + "data:image/png;base64,".length).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/).nullable().default(null),
  views: external_exports.array(PluginViewDeclarationV1Schema).max(3).default([]),
  dependencies: external_exports.array(PluginDependencyStatusV1Schema).max(64).default([])
}).strict();
var PluginRuntimeSnapshotV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION),
  revision: external_exports.number().int().nonnegative(),
  plugins: external_exports.array(PluginRuntimeEntrySnapshotV1Schema)
}).strict();
var PluginRuntimeChangedEventV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION),
  snapshot: PluginRuntimeSnapshotV1Schema
}).strict();
var PluginRuntimeErrorV1Schema = external_exports.object({
  code: external_exports.string().min(1).max(96).regex(/^[a-z0-9_]+$/),
  message: external_exports.string().min(1).max(512)
}).strict();
var PluginRuntimeSnapshotEnvelopeV1Schema = external_exports.discriminatedUnion("ok", [
  external_exports.object({
    protocolVersion: external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION),
    ok: external_exports.literal(true),
    value: PluginRuntimeSnapshotV1Schema
  }).strict(),
  external_exports.object({
    protocolVersion: external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION),
    ok: external_exports.literal(false),
    error: PluginRuntimeErrorV1Schema
  }).strict()
]);
var PLUGIN_RUNTIME_CHANNELS = Object.freeze({
  SNAPSHOT: "plugin-runtime:snapshot",
  SET_ENABLED: "plugin-runtime:setEnabled",
  REACTIVATE: "plugin-runtime:reactivate",
  CHANGED: "plugin-runtime:changed"
});

var PLUGIN_HOST_PROTOCOL_VERSION = 1;
var protocolVersion = external_exports.literal(PLUGIN_HOST_PROTOCOL_VERSION);
var requestId = external_exports.string();
var pluginId = external_exports.string();
var hostRetryAfterCodes = ["rate_limited", "capability_busy", "provider_not_ready"];
var hostResponseErrorShape = external_exports.object({
  code: external_exports.string().min(1).max(96).regex(/^[a-z0-9_]+$/),
  message: external_exports.string().min(1).max(512),
  retryAfterMs: external_exports.number().int().min(1).max(6e4).optional()
}).strict().refine((value) => value.retryAfterMs === void 0 || hostRetryAfterCodes.includes(value.code), { message: "retryAfterMs is only valid on rate_limited, capability_busy and provider_not_ready" });
var HostActivateCommandV1Schema = external_exports.object({
  protocolVersion,
  requestId,
  kind: external_exports.literal("activate"),
  pluginId,
  grantedPermissions: external_exports.array(external_exports.string())
}).strict();
var HostHealthCommandV1Schema = external_exports.object({ protocolVersion, requestId, kind: external_exports.literal("health"), pluginId }).strict();
var HostDeactivateCommandV1Schema = external_exports.object({ protocolVersion, requestId, kind: external_exports.literal("deactivate"), pluginId }).strict();
var HostShutdownCommandV1Schema = external_exports.object({ protocolVersion, requestId, kind: external_exports.literal("shutdown") }).strict();
var HostCommandEnvelopeV1Schema = external_exports.discriminatedUnion("kind", [
  HostActivateCommandV1Schema,
  HostHealthCommandV1Schema,
  HostDeactivateCommandV1Schema,
  HostShutdownCommandV1Schema
]);
var HostResponseEnvelopeV1Schema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion, requestId, ok: external_exports.literal(true), value: external_exports.unknown() }).strict(),
  external_exports.object({ protocolVersion, requestId, ok: external_exports.literal(false), error: hostResponseErrorShape }).strict()
]);
var HostHeartbeatV1Schema = external_exports.object({ protocolVersion, kind: external_exports.literal("heartbeat"), sentAt: external_exports.number() }).strict();
var HostResourceObservationV1Schema = external_exports.object({
  protocolVersion,
  kind: external_exports.literal("resource-observation"),
  eventId: external_exports.string().min(1),
  operationId: external_exports.string().min(1),
  rssKb: external_exports.number().nonnegative(),
  limitKb: external_exports.number().nonnegative()
}).strict();
var HostResourceObservationAckV1Schema = external_exports.object({
  protocolVersion,
  kind: external_exports.literal("resource-observation-ack"),
  eventId: external_exports.string().min(1),
  operationId: external_exports.string().min(1),
  accepted: external_exports.boolean()
}).strict();
var HostBootAckV1Schema = external_exports.object({
  protocolVersion,
  kind: external_exports.literal("boot-ack"),
  pluginHostVersion: external_exports.string(),
  corePackaged: external_exports.boolean()
}).strict();
var HostBootFailedV1Schema = external_exports.object({ protocolVersion, kind: external_exports.literal("boot-failed"), reason: external_exports.string() }).strict();
var HostCapabilityCallV1Schema = external_exports.object({
  protocolVersion,
  requestId,
  kind: external_exports.literal("capability-call"),
  pluginId,
  capabilityId: external_exports.string(),
  method: external_exports.string(),
  args: external_exports.array(external_exports.unknown())
}).strict();
var HostProcessHelperCallV1Schema = external_exports.object({ protocolVersion, requestId, kind: external_exports.literal("process-helper-call"), pluginId, helperId: external_exports.string().min(1).max(48), request: external_exports.unknown() }).strict();
var HostIdentityTaskChangedV1Schema = external_exports.object({
  protocolVersion,
  kind: external_exports.literal("identity-task-changed"),
  event: external_exports.object({
    task: external_exports.object({
      id: external_exports.string(),
      sourceKey: external_exports.string(),
      name: external_exports.string().optional(),
      nativeStatus: external_exports.string().nullable().optional(),
      authoredRevision: external_exports.number().optional(),
      readOnly: external_exports.boolean().optional(),
      unowned: external_exports.boolean().optional(),
      archived: external_exports.boolean().optional()
    }).strict(),
    source: external_exports.enum(["native", "pm-sync"])
  }).strict()
}).strict();

var CATEGORY_NAMES = Object.freeze(["stt", "tts", "audio", "image", "video", "doc", "text", "memory", "personal", "notify", "web"]);
var CATEGORY_ID_MAX_LENGTH = 96;
var CATEGORY_ID_PATTERN = /^teamuq\.([a-z]{2,12})@(0|[1-9][0-9]*)$/;
var OFFICIAL_CATEGORY_ID_PATTERN = new RegExp(`^teamuq\\.(?:${CATEGORY_NAMES.join("|")})@(?:0|[1-9][0-9]*)$`);
var GROUP_ID_MAX_LENGTH = 48;
var GROUP_ID_PATTERN = /^[a-z]+(?:-[a-z0-9]+)+$/;
var FEATURE_NAME_MAX_LENGTH = 48;
var FEATURE_NAME_PATTERN = /^(?:x-)?[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/;
var REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
var HEX32_PATTERN = /^[0-9a-f]{32}$/;
var BCP47_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
var OPAQUE_ID_MAX_LENGTH = 128;
var CURSOR_MAX_BYTES = 256;
var CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
var CategoryIdSchema = external_exports.string().max(CATEGORY_ID_MAX_LENGTH).regex(CATEGORY_ID_PATTERN);
var GroupIdSchema = external_exports.string().max(GROUP_ID_MAX_LENGTH).regex(GROUP_ID_PATTERN);
var GroupVersionSchema = external_exports.number().int().min(1);
var FeatureNameSchema = external_exports.string().max(FEATURE_NAME_MAX_LENGTH).regex(FEATURE_NAME_PATTERN);
var RequestIdSchema = external_exports.string().regex(REQUEST_ID_PATTERN);
var Hex32IdSchema = external_exports.string().regex(HEX32_PATTERN);
var JobIdSchema = Hex32IdSchema;
var BlobIdSchema = Hex32IdSchema;
var Bcp47Schema = external_exports.string().min(2).max(35).regex(BCP47_PATTERN);
var opaqueIdSchema = (maxLength = OPAQUE_ID_MAX_LENGTH) => external_exports.string().min(1).max(maxLength).refine((value) => !CONTROL_CHARACTER.test(value));
var OpaqueIdSchema = opaqueIdSchema();
var CursorSchema = external_exports.string().min(1).refine((value) => new TextEncoder().encode(value).length <= CURSOR_MAX_BYTES);
var TimestampMsSchema = external_exports.number().int().nonnegative();
var LinkJsonValueSchema = external_exports.lazy(() => external_exports.union([
  external_exports.null(),
  external_exports.boolean(),
  external_exports.number().finite(),
  external_exports.string(),
  external_exports.array(LinkJsonValueSchema),
  external_exports.record(external_exports.string(), LinkJsonValueSchema)
]));
function jsonUtf16Length(value) {
  try {
    return JSON.stringify(value)?.length ?? Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
function isOfficialCategoryId(value) {
  return typeof value === "string" && value.length <= CATEGORY_ID_MAX_LENGTH && OFFICIAL_CATEGORY_ID_PATTERN.test(value);
}

var CATEGORY_INPUT_CLASSES = Object.freeze(["text", "audio", "user-media", "personal-data", "biometric"]);
var CATEGORY_EFFECTS = Object.freeze(["read", "generate", "write-external", "send-external"]);
var PROVIDER_PLACEHOLDER = "{提供者}";
var SENDS_BY_INPUT_CLASS = Object.freeze({
  audio: `您的麥克風或音檔的聲音會被送給外掛「${PROVIDER_PLACEHOLDER}」`,
  text: `您輸入的文字會被送給外掛「${PROVIDER_PLACEHOLDER}」`,
  "user-media": `您選擇的圖片、影片或文件會被送給外掛「${PROVIDER_PLACEHOLDER}」`,
  "personal-data": `您的個人資料（行事曆、聯絡人、記憶內容等）會被送給外掛「${PROVIDER_PLACEHOLDER}」`
});
var WEB_SENDS = `您輸入的搜尋關鍵字會被送給外掛「${PROVIDER_PLACEHOLDER}」，再由它送到外掛宣告的搜尋服務`;
var ROWS = [
  { name: "stt", displayName: "語音轉文字（STT）", inputClass: "audio", effect: "generate", highRiskGroups: ["speech-speaker", "speech-wake"], coreOnlyGroups: ["speech-wake"], open: true },
  { name: "tts", displayName: "文字轉語音（TTS）", inputClass: "text", effect: "generate", open: true },
  { name: "audio", displayName: "音訊", inputClass: "user-media", effect: "generate", open: false },
  { name: "image", displayName: "圖片", inputClass: "user-media", effect: "generate", open: true },
  { name: "video", displayName: "影片", inputClass: "user-media", effect: "generate", open: false },
  { name: "doc", displayName: "文件", inputClass: "user-media", effect: "read", open: true },
  { name: "text", displayName: "文字", inputClass: "text", effect: "read", open: false },
  { name: "memory", displayName: "記憶", inputClass: "personal-data", effect: "write-external", open: true },
  { name: "personal", displayName: "個人資料", inputClass: "personal-data", effect: "read", open: false },
  { name: "notify", displayName: "通知", inputClass: "text", effect: "send-external", open: false },
  { name: "web", displayName: "網路", inputClass: "text", effect: "read", sends: WEB_SENDS, open: false }
];
var entryOf = (row) => Object.freeze({
  id: `teamuq.${row.name}@1`,
  permission: `cap:${row.name}`,
  displayName: row.displayName,
  sends: row.sends ?? SENDS_BY_INPUT_CLASS[row.inputClass],
  transport: "link",
  inputClass: row.inputClass,
  effect: row.effect,
  highRiskGroups: Object.freeze([...row.highRiskGroups ?? []]),
  coreOnlyGroups: Object.freeze([...row.coreOnlyGroups ?? []]),
  open: row.open
});
var CATEGORY_DIRECTORY = Object.freeze(ROWS.map(entryOf));
var GROUP_ROWS = [
  { id: "speech-transcribe", category: "teamuq.stt@1", resourceClass: "cpu", open: true },
  { id: "speech-transcribe-file", category: "teamuq.stt@1", resourceClass: "cpu", open: false },
  { id: "speech-wake", category: "teamuq.stt@1", resourceClass: "cpu", open: false },
  { id: "audio-edit", category: "teamuq.stt@1", resourceClass: "gpu", open: false },
  { id: "speech-speaker", category: "teamuq.stt@1", resourceClass: "cpu", open: false },
  { id: "speech-synthesize", category: "teamuq.tts@1", resourceClass: "cpu", open: true },
  { id: "audio-generate", category: "teamuq.audio@1", resourceClass: "gpu", open: false },
  { id: "image-generate", category: "teamuq.image@1", resourceClass: "gpu", open: true },
  { id: "image-edit", category: "teamuq.image@1", resourceClass: "gpu", open: false },
  { id: "video-generate", category: "teamuq.video@1", resourceClass: "gpu", open: false },
  { id: "doc-extract", category: "teamuq.doc@1", resourceClass: "cpu", open: true },
  { id: "text-embed", category: "teamuq.text@1", resourceClass: "cpu", open: false },
  { id: "memory-store", category: "teamuq.memory@1", resourceClass: "cpu", open: true },
  { id: "personal-calendar", category: "teamuq.personal@1", resourceClass: "net", open: false },
  { id: "personal-contacts", category: "teamuq.personal@1", resourceClass: "net", open: false },
  { id: "notify-send", category: "teamuq.notify@1", resourceClass: "net", open: false },
  { id: "web-search", category: "teamuq.web@1", resourceClass: "net", open: false }
];
var GROUP_DIRECTORY = Object.freeze(GROUP_ROWS.map((row) => Object.freeze({ ...row })));
var byId = new Map(CATEGORY_DIRECTORY.map((entry2) => [entry2.id, entry2]));
var byPermission = new Map(CATEGORY_DIRECTORY.map((entry2) => [entry2.permission, entry2]));
var categoryEntry = (id7) => byId.get(id7);
function deriveCategoryGatePermissions(directory) {
  return Object.freeze(directory.map((entry2) => entry2.permission));
}
var CATEGORY_DIRECTORY_JSON_SCHEMA = Object.freeze({
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "permission", "displayName", "sends", "transport", "inputClass", "effect", "highRiskGroups", "coreOnlyGroups", "open"],
    properties: {
      id: { type: "string", pattern: OFFICIAL_CATEGORY_ID_PATTERN.source },
      permission: { type: "string", pattern: "^cap:[a-z]{2,12}$" },
      displayName: { type: "string", minLength: 1 },
      sends: { type: "string", minLength: 1 },
      transport: { const: "link" },
      inputClass: { enum: [...CATEGORY_INPUT_CLASSES] },
      effect: { enum: [...CATEGORY_EFFECTS] },
      highRiskGroups: { type: "array", items: { type: "string", pattern: GROUP_ID_PATTERN.source }, uniqueItems: true },
      coreOnlyGroups: { type: "array", items: { type: "string", pattern: GROUP_ID_PATTERN.source }, uniqueItems: true },
      open: { type: "boolean" }
    }
  }
});

var UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
function isPlainText(value) {
  return !UNSAFE_TEXT.test(value);
}

var KB = 1024;
var MIB = 1024 * KB;
var LIMIT_TABLE = {
  messageUtf16: [16384, "UTF16", "R-LIM-1", false],
  sideDataBytes: [64 * KB, "B", "R-LNK-6", false],
  fileSideDataBytes: [MIB, "B", "R-FIL-6", true],
  helloOptionsUtf16: [4096, "UTF16", "R-LNK-12", false],
  inboundJsonMaxDepth: [64, "count", "R-LIM-1", false],
  frameBytes: [4 * MIB, "B", "R-LNK-7", true],
  messageTypeMaxLength: [48, "count", "R-SES-7", false],
  callArgsMaxItems: [8, "count", "R-CAL-8", false],
  callArgsUtf16: [16384, "UTF16", "R-CAL-5", false],
  callValueUtf16: [65536, "UTF16", "R-CAL-1", false],
  errorMessageChars: [160, "count", "R-ERR-8", false],
  rejectRetryAfterMaxMs: [5e3, "ms", "R-SES-5", false],
  providerNotReadyRetryAfterMs: [250, "ms", "R-SES-9", true],
  handshakeMs: [5e3, "ms", "R-LNK-2", true],
  pendingHandshakes: [8, "count", "R-LNK-2", true],
  openedTimeoutMs: [15e3, "ms", "R-SES-1", false],
  readyTimeoutMs: [3e4, "ms", "R-SES-9", true],
  callTimeoutMs: [3e4, "ms", "R-CAL-2", false],
  idleTimeoutMs: [5 * 6e4, "ms", "R-LNK-7", true],
  sessionBytesPerSecond: [256 * KB, "per-second", "R-LNK-7", true],
  sessionBurstBytes: [512 * KB, "B", "R-LNK-7", true],
  sessionMessagesPerSecond: [200, "per-second", "R-LNK-7", true],
  sessionBurstMessages: [100, "count", "R-LNK-7", true],
  providerOutputBytesPerSecond: [192 * KB, "per-second", "R-TTS-4", false],
  providerOutputBurstBytes: [512 * KB, "B", "R-TTS-4", false],
  callsPerSecond: [10, "per-second", "R-CAL-12", true],
  callBurst: [20, "count", "R-CAL-12", true],
  sideEffectDedupeMs: [6e4, "ms", "R-CAL-11", true],
  availabilityBudgetMs: [3e3, "ms", "R-AVL-2", true],
  describeUtf16: [16384, "UTF16", "R-DSC-2", true],
  describeGroupsMax: [16, "count", "R-DSC-2", false],
  describeModelsMax: [16, "count", "R-DSC-2", false],
  describeExtrasUtf16: [2048, "UTF16", "R-DSC-9", false],
  jobSubmitBudgetMs: [5e3, "ms", "R-JOB-21", true],
  jobResultValueUtf16: [16384, "UTF16", "R-JOB-17", false],
  jobInlineDocumentUtf16: [12288, "UTF16", "R-JOB-17", false],
  jobProgressWatchdogMs: [5 * 6e4, "ms", "R-JOB-8", true],
  jobCancelGraceMs: [1e4, "ms", "R-JOB-7", true],
  jobRetentionMinMs: [10 * 6e4, "ms", "R-JOB-15", true],
  jobRetentionMaxMs: [60 * 6e4, "ms", "R-JOB-15", true],
  jobQueuePerConsumer: [8, "count", "R-JOB-22", true],
  jobQueueGlobal: [16, "count", "R-JOB-22", true],
  jobsListPageMax: [50, "count", "R-CAL-9", false],
  jobsListPageDefault: [20, "count", "R-CAL-9", false],
  jobStatesMax: [6, "count", "R-CAL-9", false],
  inputsMax: [8, "count", "R-BLB-9", true],
  blobTransientTtlMs: [10 * 6e4, "ms", "R-FIL-2", true],
  blobJobOutputTtlMs: [60 * 6e4, "ms", "R-FIL-2", true],
  blobUploadIdleMs: [6e4, "ms", "R-FIL-6", true],
  blobUploadsPerOwner: [4, "count", "R-FIL-6", true],
  blobReadChunkBytes: [MIB, "B", "R-FIL-6", true],
  blobLightPoolBytes: [64 * MIB, "B", "R-FIL-5", true],
  blobHeavyPoolBytes: [1024 * MIB, "B", "R-FIL-5", true],
  blobLightGlobalBytes: [256 * MIB, "B", "R-FIL-5", true],
  blobHeavyGlobalBytes: [2048 * MIB, "B", "R-FIL-5", true],
  inputMaxPixels: [5e7, "pixels", "R-BLB-8", true],
  outputMaxPixels: [16777216, "pixels", "R-BLB-8", true]
};
var LINK_LIMITS = Object.freeze(
  Object.fromEntries(Object.entries(LIMIT_TABLE).map(([key4, row]) => [key4, row[0]]))
);
var LINK_LIMIT_META = Object.freeze(
  Object.fromEntries(Object.entries(LIMIT_TABLE).map(([key4, row]) => [key4, Object.freeze({ unit: row[1], rule: row[2], provisional: row[3] })]))
);
var PROVISIONAL_LIMIT_KEYS = Object.freeze(
  Object.keys(LIMIT_TABLE).filter((key4) => LIMIT_TABLE[key4][3])
);
var JOB_HOURLY_LIMITS = Object.freeze({
  "image-generate": 30,
  "image-edit": 60,
  "audio-generate": 30,
  "audio-edit": 60,
  "speech-transcribe-file": 60,
  "speech-synthesize": 60,
  "doc-extract": 60,
  "video-generate": 4,
  "notify-send": 10
});
var BLOB_CLASS_LIMITS = Object.freeze({
  image: { maxBytes: 32 * MIB, pool: "light" },
  audio: { maxBytes: 32 * MIB, pool: "light" },
  video: { maxBytes: 512 * MIB, pool: "heavy" },
  document: { maxBytes: 32 * MIB, pool: "light" },
  data: { maxBytes: 8 * MIB, pool: "light" }
});
var BLOB_MIME_ALLOWLIST = Object.freeze({
  image: ["image/png", "image/jpeg", "image/webp"],
  audio: ["audio/wav", "audio/mpeg", "audio/ogg", "audio/flac", "audio/mp4"],
  video: ["video/mp4", "video/webm"],
  document: [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "text/markdown"
  ],
  data: ["application/json", "text/plain", "text/vtt", "text/markdown"]
});
function isAllowedBlobMimeForAnyClass(mime) {
  return Object.values(BLOB_MIME_ALLOWLIST).some((list) => list.includes(mime));
}

var PROVIDER_ERROR_CODES = Object.freeze([
  "capability_request_invalid",
  "session_not_found",
  "message_too_large",
  "data_too_large",
  "rate_limited",
  "capability_busy",
  "provider_not_ready",
  "provider_error",
  "not_configured",
  "auth_failed",
  "quota_exceeded",
  "network_unreachable",
  "unsupported_options",
  "not_supported",
  "job_not_found",
  "job_cancelled",
  "provider_lost",
  "content_refused",
  "blob_not_found",
  "blob_too_large"
]);
var REJECT_ERROR_CODES = Object.freeze([
  "capability_request_invalid",
  "unsupported_options",
  "message_too_large",
  "data_too_large",
  "rate_limited",
  "provider_not_ready",
  "session_not_found"
]);
var CONTROL_PLANE_ONLY_ERROR_CODES = Object.freeze([
  "capability_undeclared",
  "capability_unresolved",
  "provider_not_allowed",
  "provider_selection_required",
  "not_granted",
  "consent_denied",
  "consumer_limit",
  "view_not_visible",
  "plugin_not_active",
  "capability_unavailable",
  "provider_endpoint_unreachable"
]);
var CONSUMER_ONLY_ERROR_CODES = Object.freeze(["open_timeout", "output_invalid"]);
var LINK_ERROR_CODES = Object.freeze([
  ...PROVIDER_ERROR_CODES,
  ...CONTROL_PLANE_ONLY_ERROR_CODES,
  ...CONSUMER_ONLY_ERROR_CODES
]);
var RETRY_AFTER_ERROR_CODES = Object.freeze(["rate_limited", "capability_busy", "provider_not_ready"]);
var errorCode = external_exports.enum(LINK_ERROR_CODES);
var errorMessage = external_exports.string().max(LINK_LIMITS.errorMessageChars).refine(isPlainText);
var retryAfterMs = external_exports.number().int().min(1);
var retryAllowed = (code2) => RETRY_AFTER_ERROR_CODES.includes(code2);
var CapabilityErrorSchema = external_exports.object({
  code: errorCode,
  message: errorMessage.optional(),
  retryAfterMs: retryAfterMs.optional()
}).strict().refine((value) => value.retryAfterMs === void 0 || retryAllowed(value.code), { message: "retryAfterMs is only valid on rate_limited, capability_busy and provider_not_ready" });
var RejectErrorSchema = external_exports.object({
  code: external_exports.enum(REJECT_ERROR_CODES),
  message: errorMessage.optional(),
  retryAfterMs: retryAfterMs.max(LINK_LIMITS.rejectRetryAfterMaxMs).optional()
}).strict().refine((value) => value.retryAfterMs === void 0 || retryAllowed(value.code), { message: "retryAfterMs is only valid on rate_limited and provider_not_ready" });
function isProviderErrorCode(value) {
  return typeof value === "string" && PROVIDER_ERROR_CODES.includes(value);
}
function normalizeProviderErrorCode(code2) {
  return isProviderErrorCode(code2) ? code2 : "provider_error";
}
var ReceivedCapabilityErrorSchema = external_exports.object({
  code: external_exports.string().min(1).max(64),
  message: errorMessage.optional(),
  retryAfterMs: retryAfterMs.optional()
}).strict().transform((value) => {
  const code2 = normalizeProviderErrorCode(value.code);
  const known = code2 === value.code;
  return {
    code: code2,
    ...known && value.message !== void 0 ? { message: value.message } : {},
    ...known && value.retryAfterMs !== void 0 && retryAllowed(code2) ? { retryAfterMs: value.retryAfterMs } : {}
  };
});

var METHOD_NAME_PATTERN = /^[A-Za-z0-9._@-]+$/;
var METHOD_NAME_MAX_LENGTH = 64;
var MethodNameSchema = external_exports.string().min(1).max(METHOD_NAME_MAX_LENGTH).regex(METHOD_NAME_PATTERN);
var DESCRIBE_SCOPE_METHODS = Object.freeze(["teamuq.describe", "teamuq.availability"]);
var FILE_METHODS = Object.freeze(["teamuq.file.put", "teamuq.file.read", "teamuq.file.release", "teamuq.file.stat"]);
var PROVIDER_STANDARD_METHODS = Object.freeze([...DESCRIBE_SCOPE_METHODS, ...FILE_METHODS, "teamuq.jobs.list"]);
var JOB_METHODS = Object.freeze(["submit", "status", "cancel", "result"]);
var SESSION_RESERVED_NAMES = Object.freeze(["open", "msg", "close"]);
var STANDARD_METHOD_ALIASES = Object.freeze(["describe", "availability"]);
var unique2 = (values) => new Set(values).size === values.length;
var modelId = external_exports.string().min(1).max(64);
var UNSUPPORTED_REASONS = Object.freeze([
  "hardware_insufficient",
  "os_unsupported",
  "language_unsupported",
  "feature_unsupported",
  "disk_insufficient",
  "region_restricted",
  "not_configured",
  "other"
]);
var AvailabilityQuerySchema = external_exports.object({
  group: GroupIdSchema.optional(),
  features: external_exports.array(FeatureNameSchema).refine(unique2).optional(),
  language: Bcp47Schema.optional(),
  voiceId: opaqueIdSchema(96).optional()
}).strict();
var AvailabilitySchema = external_exports.discriminatedUnion("state", [
  external_exports.object({ state: external_exports.literal("ready"), modelId: modelId.optional() }).strict(),
  external_exports.object({ state: external_exports.literal("downloadable"), downloadBytes: external_exports.number().int().nonnegative().optional(), modelId: modelId.optional() }).strict(),
  external_exports.object({ state: external_exports.literal("downloading"), progress: external_exports.number().min(0).max(1).optional(), modelId: modelId.optional() }).strict(),
  external_exports.object({ state: external_exports.literal("unsupported"), reason: external_exports.enum(UNSUPPORTED_REASONS), modelId: modelId.optional() }).strict()
]);
var CostHintSchema = external_exports.object({
  amount: external_exports.number().finite().nonnegative().optional(),
  currency: external_exports.string().regex(/^[A-Z]{3}$/).optional(),
  unit: external_exports.string().min(1).max(24).refine(isPlainText).optional(),
  note: external_exports.string().max(120).refine(isPlainText).optional()
}).strict();
var ResultMetaSchema = external_exports.object({
  modelId: modelId.optional(),
  costHint: CostHintSchema.optional(),
  tookMs: external_exports.number().finite().nonnegative().optional()
}).strict();
var BLOB_RETENTIONS = Object.freeze(["transient", "job-output"]);
var BLOB_CLASSES = Object.freeze(["image", "audio", "video", "document", "data"]);
var BlobHandleSchema = external_exports.object({ blobId: BlobIdSchema }).strict();
var BlobOriginSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("plugin"), pluginId: external_exports.string().min(3).max(96).regex(IDENTIFIER_PATTERN) }).strict(),
  external_exports.object({ kind: external_exports.literal("core") }).strict()
]);
var BlobRefSchema = external_exports.object({
  blobId: BlobIdSchema,
  retention: external_exports.enum(BLOB_RETENTIONS),
  mime: external_exports.string().min(1).max(255),
  sizeBytes: external_exports.number().int().nonnegative(),
  class: external_exports.enum(BLOB_CLASSES),
  origin: BlobOriginSchema,
  generated: external_exports.boolean(),
  createdAtMs: TimestampMsSchema,
  expiresAtMs: TimestampMsSchema,
  sha256: external_exports.string().regex(/^[0-9a-f]{64}$/).optional(),
  credentials: external_exports.object({ format: external_exports.literal("c2pa"), embedded: external_exports.boolean() }).strict().optional()
}).strict();
var BlobPutRequestSchema = external_exports.object({
  mime: external_exports.string().refine(isAllowedBlobMimeForAnyClass).optional(),
  sizeBytes: external_exports.number().int().nonnegative().optional(),
  retention: external_exports.literal("transient").optional(),
  uploadId: Hex32IdSchema.optional(),
  offset: external_exports.number().int().nonnegative().optional()
}).strict().superRefine((value, ctx) => {
  const resuming = value.uploadId !== void 0 || value.offset !== void 0;
  if (resuming) {
    if (value.uploadId === void 0 || value.offset === void 0) ctx.addIssue({ code: "custom", message: "resume needs both uploadId and offset" });
    if (value.mime !== void 0 || value.sizeBytes !== void 0 || value.retention !== void 0) ctx.addIssue({ code: "custom", message: "resume carries only uploadId and offset" });
  } else if (value.mime === void 0 || value.sizeBytes === void 0) {
    ctx.addIssue({ code: "custom", message: "first put needs mime and sizeBytes" });
  }
});
var BlobPutValueSchema = external_exports.object({
  uploadId: Hex32IdSchema,
  receivedBytes: external_exports.number().int().nonnegative(),
  blob: BlobRefSchema.optional()
}).strict();
var BlobReadRequestSchema = external_exports.object({
  blob: BlobHandleSchema,
  offset: external_exports.number().int().nonnegative().optional(),
  length: external_exports.number().int().min(1).max(LINK_LIMITS.blobReadChunkBytes).optional()
}).strict();
var BlobReadValueSchema = external_exports.object({
  offset: external_exports.number().int().nonnegative(),
  length: external_exports.number().int().nonnegative(),
  eof: external_exports.boolean()
}).strict();
var BlobReleaseRequestSchema = external_exports.object({ blob: BlobHandleSchema }).strict();
var BlobReleaseValueSchema = external_exports.object({ released: external_exports.literal(true) }).strict();
var BlobStatRequestSchema = external_exports.object({ blob: BlobHandleSchema }).strict();
var BlobStatValueSchema = external_exports.object({ blob: BlobRefSchema }).strict();
var JOB_STATES = Object.freeze(["queued", "running", "done", "failed", "cancelled", "interrupted"]);
var JOB_ERROR_STATES = Object.freeze(["failed", "cancelled", "interrupted"]);
var JobProgressSchema = external_exports.object({
  fraction: external_exports.number().min(0).max(1).optional(),
  stage: external_exports.string().regex(/^[a-z0-9_-]{1,48}$/).optional(),
  etaSec: external_exports.number().finite().nonnegative().optional()
}).strict();
var JobResultSchema = external_exports.object({
  outputs: external_exports.array(BlobRefSchema),
  value: LinkJsonValueSchema.optional().refine((value) => value === void 0 || jsonUtf16Length(value) <= LINK_LIMITS.jobResultValueUtf16),
  meta: ResultMetaSchema.optional()
}).strict();
var JobIdRequestSchema = external_exports.object({ jobId: JobIdSchema }).strict();
var JobSubmitArgsSchema = external_exports.record(external_exports.string(), LinkJsonValueSchema);
var isErrorState = (state2) => JOB_ERROR_STATES.includes(state2);
var jobStatusShape = {
  jobId: JobIdSchema,
  state: external_exports.enum(JOB_STATES),
  progress: JobProgressSchema.optional(),
  error: ReceivedCapabilityErrorSchema.optional(),
  createdAtMs: TimestampMsSchema,
  updatedAtMs: TimestampMsSchema
};
var checkStatus = (value, ctx) => {
  if (isErrorState(value.state) !== (value.error !== void 0)) ctx.addIssue({ code: "custom", message: "error is present exactly when the state is failed, cancelled or interrupted" });
};
var JobStatusValueSchema = external_exports.object(jobStatusShape).strict().superRefine(checkStatus);
var JobResultValueSchema = external_exports.object({ ...jobStatusShape, result: JobResultSchema.optional() }).strict().superRefine((value, ctx) => {
  checkStatus(value, ctx);
  if (value.state === "done" !== (value.result !== void 0)) ctx.addIssue({ code: "custom", message: "result is present exactly when the state is done" });
});
var JobSubmitValueSchema = external_exports.object({
  jobId: JobIdSchema,
  state: external_exports.enum(["queued", "running", "done"]),
  queuePosition: external_exports.number().int().nonnegative().optional(),
  result: JobResultSchema.optional()
}).strict().superRefine((value, ctx) => {
  if (value.state === "done" !== (value.result !== void 0)) ctx.addIssue({ code: "custom", message: "result is present exactly when submit completed synchronously" });
  if (value.queuePosition !== void 0 && value.state !== "queued") ctx.addIssue({ code: "custom", message: "queuePosition belongs to queued jobs" });
});
var JobsListRequestSchema = external_exports.object({
  group: GroupIdSchema.optional(),
  states: external_exports.array(external_exports.enum(JOB_STATES)).min(1).max(LINK_LIMITS.jobStatesMax).refine(unique2).optional(),
  limit: external_exports.number().int().min(1).max(LINK_LIMITS.jobsListPageMax).optional(),
  cursor: CursorSchema.optional()
}).strict();
var JobListItemSchema = external_exports.object({ ...jobStatusShape, group: GroupIdSchema }).strict().superRefine(checkStatus);
var JobsListValueSchema = external_exports.object({ jobs: external_exports.array(JobListItemSchema), nextCursor: CursorSchema.optional() }).strict();
var STANDARD_METHOD_ARGS = Object.freeze({
  "teamuq.describe": external_exports.tuple([]),
  "teamuq.availability": external_exports.union([external_exports.tuple([]), external_exports.tuple([AvailabilityQuerySchema])]),
  "teamuq.file.put": external_exports.tuple([BlobPutRequestSchema]),
  "teamuq.file.read": external_exports.tuple([BlobReadRequestSchema]),
  "teamuq.file.release": external_exports.tuple([BlobReleaseRequestSchema]),
  "teamuq.file.stat": external_exports.tuple([BlobStatRequestSchema]),
  "teamuq.jobs.list": external_exports.tuple([JobsListRequestSchema]),
  submit: external_exports.tuple([JobSubmitArgsSchema]),
  status: external_exports.tuple([JobIdRequestSchema]),
  cancel: external_exports.tuple([JobIdRequestSchema]),
  result: external_exports.tuple([JobIdRequestSchema])
});

var DATA_CLASSES = Object.freeze(["local", "cloud"]);
var MODEL_KINDS = Object.freeze(["local", "remote"]);
var CONTENT_CATEGORIES = Object.freeze(["sexual", "violence", "self-harm", "hate", "illegal", "minors", "other"]);
var CONTENT_LEVELS = Object.freeze(["off", "low", "medium", "high"]);
var CONTENT_FILTERED_BY = Object.freeze(["provider-model", "provider-rules", "none"]);
var unique3 = (values) => new Set(values).size === values.length;
var DataClassSchema = external_exports.enum(DATA_CLASSES);
var ModelInfoSchema = external_exports.object({
  modelId: external_exports.string().min(1).max(64),
  name: external_exports.string().min(1).max(96).refine(isPlainText).optional(),
  version: external_exports.string().min(1).max(32).optional(),
  languages: external_exports.array(Bcp47Schema).optional(),
  sizeBytes: external_exports.number().int().nonnegative().optional(),
  kind: external_exports.enum(MODEL_KINDS).optional()
}).strict();
var LimitListSchema = external_exports.union([
  external_exports.array(external_exports.number().finite()).max(256),
  external_exports.array(external_exports.string().max(256)).max(256)
]).refine((values) => new Set(values).size === values.length, { message: "limit lists must not repeat values" });
var CapabilityLimitsSchema = external_exports.record(external_exports.string().min(1), external_exports.union([external_exports.number().finite(), LimitListSchema]));
var ContentPolicyDeclarationSchema = external_exports.object({
  filteredBy: external_exports.enum(CONTENT_FILTERED_BY),
  categories: external_exports.array(external_exports.object({ category: external_exports.enum(CONTENT_CATEGORIES), level: external_exports.enum(CONTENT_LEVELS) }).strict()).max(CONTENT_CATEGORIES.length)
}).strict().superRefine((value, ctx) => {
  if (!unique3(value.categories.map((entry2) => entry2.category))) ctx.addIssue({ code: "custom", message: "categories must not repeat a category" });
  if (value.filteredBy === "none" && value.categories.length !== 0) ctx.addIssue({ code: "custom", message: "filteredBy none declares no categories" });
  if (value.filteredBy !== "none" && value.categories.length === 0) ctx.addIssue({ code: "custom", message: "a filter declares at least one category" });
});
var GroupDescriptionSchema = external_exports.object({
  id: GroupIdSchema,
  version: GroupVersionSchema,
  methods: external_exports.array(MethodNameSchema).refine(unique3),
  features: external_exports.array(FeatureNameSchema).refine(unique3),
  limits: CapabilityLimitsSchema,
  models: external_exports.array(ModelInfoSchema),
  defaultModelId: external_exports.string().min(1).max(64).optional(),
  contentPolicy: ContentPolicyDeclarationSchema.optional(),
  extras: external_exports.record(external_exports.string(), LinkJsonValueSchema).refine((value) => jsonUtf16Length(value) <= LINK_LIMITS.describeExtrasUtf16).optional()
}).strict();
var ProviderDescriptionSchema = external_exports.object({
  specVersion: external_exports.string().min(1).max(32),
  category: CategoryIdSchema,
  dataClass: DataClassSchema,
  groups: external_exports.array(GroupDescriptionSchema).max(LINK_LIMITS.describeGroupsMax)
}).strict().superRefine((value, ctx) => {
  if (!unique3(value.groups.map((group) => `${group.id}@${group.version}`))) ctx.addIssue({ code: "custom", message: "a group version is described once" });
  if (jsonUtf16Length(value) > LINK_LIMITS.describeUtf16) ctx.addIssue({ code: "custom", message: "describe response is larger than the standard allows" });
});

var LINK_PROTOCOL_VERSION = 1;
var LINK_IDENTITY_FIELDS = Object.freeze(["source", "callerId", "pluginId", "senderId"]);
var LINK_SCOPES = Object.freeze(["use", "describe"]);
var LINK_INBOUND_TYPES = Object.freeze(["hello", "call", "msg", "close"]);
var LINK_OUTBOUND_TYPES = Object.freeze(["opened", "result", "event", "reject", "msg", "close"]);
var LINK_CLOSE_REASONS = Object.freeze([
  "consumer_closed",
  "view_hidden",
  "view_occluded",
  "view_closed",
  "view_reloaded",
  "provider_gone",
  "provider_crashed",
  "provider_closed",
  "consumer_gone",
  "rate_limited",
  "idle_timeout",
  "permission_revoked",
  "protocol_error",
  "shutdown"
]);
var LINK_CLOSE_CODES = Object.freeze({
  consumer_closed: 1e3,
  view_hidden: 4001,
  view_occluded: 4002,
  view_closed: 4003,
  view_reloaded: 4004,
  provider_gone: 4005,
  provider_crashed: 4006,
  provider_closed: 4007,
  consumer_gone: 4008,
  rate_limited: 4009,
  idle_timeout: 4010,
  permission_revoked: 4011,
  protocol_error: 4012,
  shutdown: 4013
});
var LINK_HANDSHAKE_CLOSE_CODES = Object.freeze({ normal: 1e3, providerCrashedAbnormal: 1006, ticketInvalid: 4401, groupNotAuthorized: 4403, handshakeTimeout: 4408 });
var JOB_EVENT_NAMES = Object.freeze(["job-progress", "job-done", "job-failed"]);
var type = external_exports.string().min(1).max(LINK_LIMITS.messageTypeMaxLength);
var frame = (kind) => external_exports.literal(kind);
var sideEffectless = external_exports.literal(true);
var MediaInputIdentitySchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("blob"), blob: BlobHandleSchema }).strict(),
  external_exports.object({ kind: external_exports.literal("inline"), mime: external_exports.string().min(1).max(255) }).strict()
]);
var SessionMessageSchema = external_exports.object({ type }).catchall(LinkJsonValueSchema).refine((value) => jsonUtf16Length(value) <= LINK_LIMITS.messageUtf16);
var LinkHelloSchema = external_exports.object({
  t: frame("hello"),
  v: external_exports.literal(LINK_PROTOCOL_VERSION),
  ticket: external_exports.string().min(1).max(2048),
  group: GroupIdSchema.optional(),
  groupVersion: GroupVersionSchema.optional(),
  options: external_exports.record(external_exports.string(), LinkJsonValueSchema).refine((value) => jsonUtf16Length(value) <= LINK_LIMITS.helloOptionsUtf16).optional()
}).strict();
var LinkCallSchema = external_exports.object({
  t: frame("call"),
  id: RequestIdSchema,
  method: MethodNameSchema,
  args: external_exports.array(LinkJsonValueSchema).max(LINK_LIMITS.callArgsMaxItems).refine((value) => jsonUtf16Length(value) <= LINK_LIMITS.callArgsUtf16),
  hasData: sideEffectless.optional()
}).strict();
var LinkMsgSchema = external_exports.object({ t: frame("msg"), message: SessionMessageSchema, hasData: sideEffectless.optional() }).strict();
var LinkCloseSchema = external_exports.object({ t: frame("close"), reason: external_exports.enum(LINK_CLOSE_REASONS) }).strict();
var LinkInboundSchema = external_exports.discriminatedUnion("t", [LinkHelloSchema, LinkCallSchema, LinkMsgSchema, LinkCloseSchema]);
var LinkOpenedSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({
    t: frame("opened"),
    v: external_exports.literal(LINK_PROTOCOL_VERSION),
    ok: external_exports.literal(true),
    scope: external_exports.enum(LINK_SCOPES),
    group: GroupIdSchema.optional(),
    groupVersion: GroupVersionSchema.optional(),
    features: external_exports.array(FeatureNameSchema),
    modelId: external_exports.string().min(1).max(64).optional(),
    dataClass: DataClassSchema
  }).strict(),
  external_exports.object({ t: frame("opened"), v: external_exports.literal(LINK_PROTOCOL_VERSION), ok: external_exports.literal(false), error: ReceivedCapabilityErrorSchema }).strict()
]);
var LinkResultSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({
    t: frame("result"),
    id: RequestIdSchema,
    ok: external_exports.literal(true),
    value: LinkJsonValueSchema.refine((value) => jsonUtf16Length(value) <= LINK_LIMITS.callValueUtf16),
    meta: ResultMetaSchema.optional(),
    hasData: sideEffectless.optional()
  }).strict(),
  external_exports.object({ t: frame("result"), id: RequestIdSchema, ok: external_exports.literal(false), error: ReceivedCapabilityErrorSchema }).strict()
]);
var LinkEventSchema = external_exports.discriminatedUnion("event", [
  external_exports.object({ t: frame("event"), jobId: JobIdSchema, event: external_exports.literal("job-progress"), progress: JobProgressSchema }).strict(),
  external_exports.object({ t: frame("event"), jobId: JobIdSchema, event: external_exports.literal("job-done"), result: JobResultSchema }).strict(),
  external_exports.object({ t: frame("event"), jobId: JobIdSchema, event: external_exports.literal("job-failed"), error: ReceivedCapabilityErrorSchema }).strict()
]);
var LinkRejectSchema = external_exports.object({ t: frame("reject"), error: RejectErrorSchema }).strict();
var LinkOutboundSchema = external_exports.union([LinkOpenedSchema, LinkResultSchema, LinkEventSchema, LinkRejectSchema, LinkMsgSchema, LinkCloseSchema]);

var LINK_VIEW_STATUSES = Object.freeze([...CAPABILITY_DEPENDENCY_STATUSES, "not_granted"]);
var OPEN_LINK_INTENTS = Object.freeze(["enroll", "recognize"]);
var LINK_INTENTS = Object.freeze([...OPEN_LINK_INTENTS, "manage"]);
var LINK_CALLER_KINDS = Object.freeze(["view", "backend", "core"]);
var LINK_VIA_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
var LINK_VIA_STANDARD_VALUES = Object.freeze(["voice-input", "wake", "ai-chat", "settings", "system"]);
var LINK_ENDPOINT_PATTERN = /^ws:\/\/127\.0\.0\.1:([0-9]{1,5})\/l\/[0-9a-f]{32,64}$/;
var LINK_MAX_PROVIDERS = 32;
var LINK_MAX_ENTRIES = 64;
var LINK_MAX_REQUESTED_GROUPS = 4;
var LINK_CHANGE_REASON_STATUS = Object.freeze({
  provider_installed: "available",
  provider_selected: "available",
  provider_ready: "available",
  permission_granted: "available",
  provider_starting: "provider_not_ready",
  provider_crashed: "provider_not_ready",
  provider_removed: "unresolved",
  provider_disabled: "unresolved",
  signing_policy: "provider_not_allowed",
  permission_revoked: "not_granted"
});
var viewStatus = external_exports.enum(LINK_VIEW_STATUSES);
var providerId = external_exports.string().min(3).max(96).regex(IDENTIFIER_PATTERN);
var pluginId2 = external_exports.string().min(3).max(96).regex(IDENTIFIER_PATTERN);
var requestedGroups = external_exports.array(GroupIdSchema).max(LINK_MAX_REQUESTED_GROUPS);
var LinkProviderViewSchema = external_exports.object({
  id: providerId,
  version: external_exports.string().min(1).max(32),
  name: external_exports.string().min(1).max(96).refine(isPlainText),
  signer: external_exports.enum(PLUGIN_SIGNER_KINDS)
}).strict();
var LinkCandidateProviderSchema = LinkProviderViewSchema.extend({ dataClass: DataClassSchema }).strict();
var LinkCapabilityEntrySchema = external_exports.object({
  category: CategoryIdSchema,
  status: viewStatus,
  providers: external_exports.array(LinkCandidateProviderSchema).max(LINK_MAX_PROVIDERS),
  selected: providerId.optional()
}).strict().superRefine((entry2, ctx) => {
  if (entry2.selected !== void 0 && !entry2.providers.some((provider3) => provider3.id === entry2.selected)) {
    ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["selected"], message: "selected must name one of the candidate providers" });
  }
  if (new Set(entry2.providers.map((provider3) => provider3.id)).size !== entry2.providers.length) {
    ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["providers"], message: "candidate providers must be unique" });
  }
});
var LinkCapabilityEntryListSchema = external_exports.array(LinkCapabilityEntrySchema).max(LINK_MAX_ENTRIES);
var OpenLinkRequestSchema = external_exports.object({
  providerId: providerId.optional(),
  scope: external_exports.enum(["use", "describe"]).optional(),
  groups: requestedGroups.optional(),
  intent: external_exports.enum(OPEN_LINK_INTENTS).optional()
}).strict();
var OpenLinkCallSchema = OpenLinkRequestSchema.extend({ category: CategoryIdSchema }).strict();
var endpoint = external_exports.string().max(96).regex(LINK_ENDPOINT_PATTERN).refine((value) => {
  const port = Number(LINK_ENDPOINT_PATTERN.exec(value)?.[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}, { message: "endpoint port must be 1..65535" });
var LinkTicketSchema = external_exports.object({
  linkId: Hex32IdSchema,
  provider: LinkProviderViewSchema,
  endpoint,
  ticket: external_exports.string().min(1).max(2048),
  expiresAt: TimestampMsSchema
}).strict();
var LinkSourceSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("plugin"), pluginId: pluginId2 }).strict(),
  external_exports.object({ kind: external_exports.literal("core"), via: external_exports.string().regex(LINK_VIA_PATTERN).optional() }).strict(),
  external_exports.object({ kind: external_exports.literal("agent"), agentId: external_exports.string().min(1).max(128) }).strict()
]);
var LinkWhoSchema = external_exports.object({
  source: LinkSourceSchema,
  callerKind: external_exports.enum(LINK_CALLER_KINDS),
  category: CategoryIdSchema,
  scope: external_exports.enum(["use", "describe"]),
  highRisk: external_exports.array(GroupIdSchema).max(1),
  intent: external_exports.enum(LINK_INTENTS).optional()
}).strict().superRefine((who, ctx) => {
  const issue = (path, message) => {
    ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: [path], message });
  };
  if (who.source.kind === "agent") issue("source", "the agent source is reserved and never issued");
  if (who.source.kind === "core" !== (who.callerKind === "core")) issue("callerKind", "callerKind core pairs with the core source and nothing else");
  if (who.scope === "describe" && (who.highRisk.length > 0 || who.intent !== void 0)) issue("scope", "a describe ticket carries no high risk group and no intent");
  if (who.intent !== void 0 && who.highRisk[0] !== "speech-speaker") issue("intent", "an intent only goes with the speech-speaker group");
  if (who.intent === "manage" && who.source.kind !== "core") issue("intent", "manage is the Core settings intent");
  if (who.intent !== void 0 && who.intent !== "manage" && who.source.kind !== "plugin") issue("intent", "enroll and recognize belong to a plugin consumer");
  const entry2 = categoryEntry(who.category);
  for (const group of who.highRisk) {
    if (entry2 !== void 0 && !entry2.highRiskGroups.includes(group)) issue("highRisk", `${group} is not a high risk group of ${who.category}`);
  }
});
var LinkCapabilityChangeEventSchema = external_exports.object({
  kind: external_exports.literal("change"),
  category: CategoryIdSchema,
  status: viewStatus,
  provider: LinkProviderViewSchema.nullable(),
  reason: external_exports.string().min(1).max(48)
}).strict().superRefine((event, ctx) => {
  const expected = LINK_CHANGE_REASON_STATUS[event.reason];
  if (expected !== void 0 && expected !== event.status) {
    ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["status"], message: `reason ${event.reason} maps to status ${expected}` });
  }
  if (event.status === "available" && event.provider === null) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["provider"], message: "an available category names its provider" });
  if (event.status === "unresolved" && event.provider !== null) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["provider"], message: "an unresolved category has no provider" });
});
var LinkClosedEventSchema = external_exports.object({
  kind: external_exports.literal("link-closed"),
  linkId: Hex32IdSchema,
  reason: external_exports.enum(LINK_CLOSE_REASONS)
}).strict();
var LinkCapabilityEventSchema = external_exports.union([LinkCapabilityChangeEventSchema, LinkClosedEventSchema]);

var PLUGIN_CAPABILITY_CHANNELS = Object.freeze({
  REQUEST: "plugin-view:capability",
  EVENT: "plugin-view:capability-event"
});
var CATEGORY_GATE_PERMISSIONS = deriveCategoryGatePermissions(CATEGORY_DIRECTORY);
var CAPABILITY_LIMITS = Object.freeze({
  messageBytes: 16 * 1024,
  dataBytes: 64 * 1024,
  optionsBytes: 4 * 1024,
  sessionsPerConsumer: 2,
  bytesPerSecond: 256 * 1024,
  burstBytes: 512 * 1024,
  messagesPerSecond: 200,
  burstMessages: 100,
  openTimeoutMs: 15e3,
  idleSessionMs: 5 * 6e4,
  consentCooldownMs: 8e3
});
var CAPABILITY_ERROR_CODES = Object.freeze([
  "capability_request_invalid",
  "capability_undeclared",
  "capability_unresolved",
  "provider_not_ready",
  "provider_not_allowed",
  "provider_selection_required",
  "not_granted",
  "consent_denied",
  "capability_busy",
  "consumer_limit",
  "view_not_visible",
  "session_not_found",
  "message_too_large",
  "data_too_large",
  "rate_limited",
  "provider_error",
  "open_timeout",
  "plugin_not_active",
  "capability_unavailable",
  "not_configured",
  "auth_failed",
  "quota_exceeded",
  "network_unreachable",
  "unsupported_options",
  "provider_endpoint_unreachable"
]);
var CAPABILITY_PROVIDER_OPEN_ERRORS = Object.freeze(["not_configured", "auth_failed", "quota_exceeded", "network_unreachable", "unsupported_options"]);
var CAPABILITY_CLOSE_REASONS = Object.freeze([
  "consumer_closed",
  "view_hidden",
  "view_occluded",
  "view_closed",
  "view_reloaded",
  "provider_gone",
  "provider_crashed",
  "provider_closed",
  "consumer_gone",
  "rate_limited",
  "idle_timeout",
  "target_changed",
  "permission_revoked",
  "protocol_error",
  "shutdown"
]);
var CAPABILITY_VIEW_STATUSES = Object.freeze([...CAPABILITY_DEPENDENCY_STATUSES, "not_granted"]);
var capabilityId = external_exports.string().regex(CAPABILITY_PATTERN).max(96);
var sessionId = external_exports.string().regex(/^[0-9a-f]{32}$/);
var closeReason = external_exports.enum(CAPABILITY_CLOSE_REASONS);
var viewStatus2 = external_exports.enum(CAPABILITY_VIEW_STATUSES);
var pluginId3 = external_exports.string().regex(IDENTIFIER_PATTERN).max(96);
var jsonBytes = (value) => {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};
var CapabilityMessageSchema = external_exports.record(external_exports.string().max(64), external_exports.unknown()).refine((value) => typeof value["type"] === "string" && value["type"].length >= 1 && value["type"].length <= 48, { message: "message.type is required" }).refine((value) => jsonBytes(value) <= CAPABILITY_LIMITS.messageBytes, { message: "message too large" });
var CapabilityOptionsSchema = external_exports.record(external_exports.string().max(64), external_exports.unknown()).refine((value) => jsonBytes(value) <= CAPABILITY_LIMITS.optionsBytes, { message: "options too large" });
var CapabilityBytesSchema = external_exports.custom((value) => value instanceof Uint8Array);
var CapabilityRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("list") }).strict(),
  external_exports.object({ op: external_exports.literal("open"), capability: capabilityId, options: CapabilityOptionsSchema.optional() }).strict(),
  OpenLinkCallSchema.extend({ op: external_exports.literal("openLink") }).strict()
]);
var CapabilityProviderViewSchema = external_exports.object({
  id: pluginId3,
  version: external_exports.string().max(32),
  name: external_exports.string().max(96),
  signer: external_exports.enum(PLUGIN_SIGNER_KINDS)
}).strict();
var CapabilityEntrySchema = external_exports.object({
  capability: capabilityId,
  required: external_exports.boolean(),
  status: viewStatus2,
  provider: CapabilityProviderViewSchema.nullable(),
  permission: external_exports.string().max(64).nullable()
}).strict();
var CapabilityEntryListSchema = external_exports.array(CapabilityEntrySchema).max(64);
var CapabilityOpenedSchema = external_exports.object({ sessionId, capability: capabilityId, provider: CapabilityProviderViewSchema }).strict();
var CapabilityErrorEnvelopeSchema = external_exports.object({ ok: external_exports.literal(false), error: external_exports.enum(CAPABILITY_ERROR_CODES), message: external_exports.string().max(160).optional(), retryAfterMs: external_exports.number().int().min(1).max(6e4).optional() }).strict();
var CapabilityEnvelopeSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ ok: external_exports.literal(true), value: external_exports.unknown() }).strict(),
  CapabilityErrorEnvelopeSchema
]);
var CapabilityEventSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("message"), sessionId, message: CapabilityMessageSchema, data: CapabilityBytesSchema.optional() }).strict(),
  external_exports.object({ kind: external_exports.literal("closed"), sessionId, reason: closeReason }).strict(),
  external_exports.object({ kind: external_exports.literal("change"), capability: capabilityId, status: viewStatus2, provider: CapabilityProviderViewSchema.nullable(), reason: external_exports.string().max(48).optional() }).strict()
]);
var protocolVersion2 = external_exports.literal(1);
var externalErrorCode = external_exports.string().min(3).max(96).regex(/^[a-z0-9_]+$/);
var base64Data = external_exports.string().max(Math.ceil(CAPABILITY_LIMITS.dataBytes * 4 / 3) + 8).regex(/^[A-Za-z0-9+/]*={0,2}$/);
var ExternalSessionOpenSchema = external_exports.object({
  protocolVersion: protocolVersion2,
  kind: external_exports.literal("ext-session-open"),
  sessionId,
  capability: capabilityId,
  callerPluginId: pluginId3,
  options: CapabilityOptionsSchema
}).strict();
var ExternalSessionOpenedSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion2, kind: external_exports.literal("ext-session-opened"), sessionId, ok: external_exports.literal(true) }).strict(),
  external_exports.object({ protocolVersion: protocolVersion2, kind: external_exports.literal("ext-session-opened"), sessionId, ok: external_exports.literal(false), error: external_exports.object({ code: externalErrorCode, message: external_exports.string().max(240) }).strict() }).strict()
]);
var ExternalSessionMessageSchema = external_exports.object({
  protocolVersion: protocolVersion2,
  kind: external_exports.literal("ext-session-message"),
  sessionId,
  message: CapabilityMessageSchema,
  data: base64Data.optional()
}).strict();
var ExternalSessionCloseSchema = external_exports.object({
  protocolVersion: protocolVersion2,
  kind: external_exports.literal("ext-session-close"),
  sessionId,
  reason: external_exports.string().min(3).max(48).regex(/^[a-z0-9_]+$/)
}).strict();

var LOOPBACK_SERVICE_LIMITS = Object.freeze({ maxServices: 8, minPort: 1024, maxPort: 65535, maxPurposeUtf16: 120 });
var LOOPBACK_SERVICE_PROTOCOLS = Object.freeze(["http", "ws"]);
var LoopbackServiceSchema = external_exports.object({
  id: external_exports.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  port: external_exports.number().int().min(LOOPBACK_SERVICE_LIMITS.minPort).max(LOOPBACK_SERVICE_LIMITS.maxPort),
  protocols: external_exports.array(external_exports.enum(LOOPBACK_SERVICE_PROTOCOLS)).min(1).max(LOOPBACK_SERVICE_PROTOCOLS.length),
  purpose: external_exports.string().min(1).max(LOOPBACK_SERVICE_LIMITS.maxPurposeUtf16).refine(isPlainText, { message: "must be plain text" })
}).strict().refine((service) => new Set(service.protocols).size === service.protocols.length, { message: "protocols must not contain duplicates", path: ["protocols"] });

var SETTINGS_SCHEMA_LIMITS = Object.freeze({ fields: 16, options: 16, labelChars: 48, helpChars: 200, textChars: 200, unitChars: 12 });
var KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
var OPTION_VALUE_PATTERN = /^[A-Za-z0-9._-]{1,48}$/;
var FORBIDDEN_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
var plainText = (max) => external_exports.string().min(1).max(max).refine(isPlainText, { message: "must be plain text without control, bidi or zero-width characters" });
var key = external_exports.string().regex(KEY_PATTERN).refine((value) => !FORBIDDEN_KEYS.has(value), { message: "must not be a reserved object key" });
var finite = external_exports.number().finite().min(-1e9).max(1e9);
var common = { key, label: plainText(SETTINGS_SCHEMA_LIMITS.labelChars), help: plainText(SETTINGS_SCHEMA_LIMITS.helpChars).optional() };
var ToggleField = external_exports.object({ ...common, type: external_exports.literal("toggle"), default: external_exports.boolean() }).strict();
var ChoiceField = external_exports.object({
  ...common,
  type: external_exports.literal("choice"),
  options: external_exports.array(external_exports.object({ value: external_exports.string().regex(OPTION_VALUE_PATTERN), label: plainText(SETTINGS_SCHEMA_LIMITS.labelChars) }).strict()).min(2).max(SETTINGS_SCHEMA_LIMITS.options),
  default: external_exports.string().regex(OPTION_VALUE_PATTERN)
}).strict();
var RangeField = external_exports.object({
  ...common,
  type: external_exports.literal("range"),
  min: finite,
  max: finite,
  step: external_exports.number().finite().positive().max(1e9).default(1),
  unit: plainText(SETTINGS_SCHEMA_LIMITS.unitChars).optional(),
  default: finite
}).strict();
var TextField = external_exports.object({
  ...common,
  type: external_exports.literal("text"),
  maxLength: external_exports.number().int().min(1).max(SETTINGS_SCHEMA_LIMITS.textChars).default(100),
  default: external_exports.string().max(SETTINGS_SCHEMA_LIMITS.textChars)
}).strict();
var PluginSettingFieldSchema = external_exports.discriminatedUnion("type", [ToggleField, ChoiceField, RangeField, TextField]);
function validateSettingValue(field, value) {
  switch (field.type) {
    case "toggle":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false, issue: "type" };
    case "choice":
      if (typeof value !== "string") return { ok: false, issue: "type" };
      return field.options.some((option) => option.value === value) ? { ok: true, value } : { ok: false, issue: "option" };
    case "range": {
      if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, issue: "type" };
      if (value < field.min || value > field.max) return { ok: false, issue: "range" };
      const steps = (value - field.min) / field.step;
      return Math.abs(steps - Math.round(steps)) > 1e-9 ? { ok: false, issue: "step" } : { ok: true, value };
    }
    case "text":
      if (typeof value !== "string") return { ok: false, issue: "type" };
      if (!isPlainText(value)) return { ok: false, issue: "chars" };
      return [...value].length > field.maxLength ? { ok: false, issue: "length" } : { ok: true, value };
  }
}
var PluginSettingsSchemaSchema = external_exports.object({
  title: plainText(SETTINGS_SCHEMA_LIMITS.labelChars).optional(),
  summary: plainText(SETTINGS_SCHEMA_LIMITS.helpChars).optional(),
  fields: external_exports.array(PluginSettingFieldSchema).min(1).max(SETTINGS_SCHEMA_LIMITS.fields)
}).strict().superRefine((schema, context) => {
  const seen = /* @__PURE__ */ new Set();
  schema.fields.forEach((field, index) => {
    const fail3 = (path, message) => {
      context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["fields", index, path], message });
    };
    if (seen.has(field.key)) fail3("key", "setting keys must be unique");
    seen.add(field.key);
    if (field.type === "range" && field.min >= field.max) fail3("max", "max must be greater than min");
    if (field.type === "choice" && new Set(field.options.map((option) => option.value)).size !== field.options.length) fail3("options", "option values must be unique");
    const verdict = validateSettingValue(field, field.default);
    if (!verdict.ok) fail3("default", `default is not a valid value (${verdict.issue})`);
  });
});
var valuesOf = (entries) => {
  const values = /* @__PURE__ */ Object.create(null);
  for (const [name, value] of entries) values[name] = value;
  return { ...values };
};
function effectiveSettingValues(schema, stored) {
  return valuesOf(schema.fields.map((field) => {
    const verdict = validateSettingValue(field, Object.prototype.hasOwnProperty.call(stored, field.key) ? stored[field.key] : void 0);
    return [field.key, verdict.ok ? verdict.value : field.default];
  }));
}
var SETTINGS_SCHEMA_PERMISSION = "settings:plugin";
var NAMESPACE_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*-$/u;
function assetPackNamespaceOf(pluginId9) {
  const dot = pluginId9.indexOf(".");
  if (dot <= 0 || dot === pluginId9.length - 1 || !IDENTIFIER_PATTERN.test(pluginId9)) return null;
  return `${pluginId9.slice(0, dot)}.asset.${pluginId9.slice(dot + 1)}-`;
}
function isAssetPackPrefixOf(pluginId9, prefix) {
  const namespace = assetPackNamespaceOf(pluginId9);
  return namespace !== null && prefix.length <= 90 && NAMESPACE_PATTERN.test(prefix) && prefix.startsWith(namespace);
}

var pluginId4 = external_exports.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/).max(96);
var identifier = external_exports.string().min(1).max(128).regex(/^[A-Za-z0-9._:/-]+$/);
var cursor = external_exports.string().min(1).max(512);
var generation = external_exports.string().min(1).max(96);
var permission = external_exports.string().min(1).max(96);
var presentStateValue = external_exports.custom((value) => value !== void 0);
var PLUGIN_HOST_DATA_CAPABILITIES = Object.freeze({
  workRecords: "teamuq.work-records@1",
  agentDirectory: "teamuq.agent-directory@1",
  projectDirectory: "teamuq.project-directory@1",
  pluginState: "teamuq.plugin-state@1",
  programApi: "teamuq.program-api@1",
  capabilityControl: "teamuq.capability-control@1",
  aiChat: "teamuq.ai-chat@1",
  secrets: "teamuq.secrets@1"
});
var PLUGIN_STATE_RETIRED_ERROR_CODE = "plugin_state_retired";
var PLUGIN_HOST_PASSTHROUGH_ERROR_CODES = Object.freeze([PLUGIN_STATE_RETIRED_ERROR_CODE, ...CONTROL_PLANE_ONLY_ERROR_CODES]);
var PLUGIN_HOST_DATA_DEPRECATIONS = Object.freeze({
  pluginState: Object.freeze({ capabilityId: "teamuq.plugin-state@1", deprecatedIn: "1.1.0", removedIn: "2.0.0", retiredErrorCode: PLUGIN_STATE_RETIRED_ERROR_CODE })
});
var PLUGIN_HOST_DATA_PERMISSIONS = Object.freeze({
  workRecords: "work-records:read",
  agentDirectory: "agent-directory:read",
  projectDirectory: "project-directory:read",
  pluginStateRead: "plugin-state:read",
  pluginStateWrite: "plugin-state:write",
  aiChat: "ai:chat",
  secrets: "secrets:plugin"
});
var PLUGIN_HOST_DATA_LIMITS = Object.freeze({
  pageSize: 100,
  payloadBytes: 256 * 1024,
  stateValueBytes: 32 * 1024,
  stateBatchBytes: 256 * 1024
});
var PLUGIN_HOST_DATA_METHODS = Object.freeze({
  workRecords: Object.freeze({ openSnapshot: "openSettledSnapshot", readPage: "readPage" }),
  agentDirectory: Object.freeze({ openSnapshot: "openSnapshot", readPage: "readPage" }),
  projectDirectory: Object.freeze({ openSnapshot: "openSnapshot", readPage: "readPage" }),
  pluginState: Object.freeze({ readPage: "readPage", writeBatch: "writeBatch", deleteBatch: "deleteBatch" }),
  programApi: Object.freeze({ call: "call" }),
  capabilityControl: Object.freeze({ list: "list", openLink: "openLink" }),
  aiChat: Object.freeze({ getOptions: "getOptions", openSession: "openSession", complete: "complete", attachSession: "attachSession", send: "send", interrupt: "interrupt", close: "close" }),
  secrets: Object.freeze({ get: "get", set: "set", remove: "remove", list: "list", available: "available" })
});
var PluginHostDataRequestV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(1),
  requestId: external_exports.string().min(1).max(64),
  kind: external_exports.literal("capability-call"),
  pluginId: pluginId4,
  capabilityId: external_exports.enum([
    PLUGIN_HOST_DATA_CAPABILITIES.workRecords,
    PLUGIN_HOST_DATA_CAPABILITIES.agentDirectory,
    PLUGIN_HOST_DATA_CAPABILITIES.projectDirectory,
    PLUGIN_HOST_DATA_CAPABILITIES.pluginState,
    PLUGIN_HOST_DATA_CAPABILITIES.programApi,
    PLUGIN_HOST_DATA_CAPABILITIES.capabilityControl,
    PLUGIN_HOST_DATA_CAPABILITIES.aiChat,
    PLUGIN_HOST_DATA_CAPABILITIES.secrets
  ]),
  method: external_exports.string().min(1).max(64).regex(/^[A-Za-z0-9._@-]+$/),
  args: external_exports.array(external_exports.unknown()).max(8)
}).strict();
var PluginHostDataPermissionsV1Schema = external_exports.array(permission).max(64);
var PluginDataPageRequestV1Schema = external_exports.object({
  snapshotId: identifier.optional(),
  cursor: cursor.nullable(),
  limit: external_exports.number().int().min(1).max(100)
}).strict();
var PluginHostSnapshotV1Schema = external_exports.object({
  snapshotId: identifier,
  generation,
  highWatermark: external_exports.string().max(40).nullable(),
  idEpoch: external_exports.string().max(64).optional()
}).strict();
var PluginHostWorkRecordV1Schema = external_exports.object({
  id: identifier,
  agentId: identifier,
  projectId: identifier.nullable(),
  sessionId: identifier.nullable(),
  providerId: identifier.nullable(),
  punchId: identifier,
  punchType: external_exports.enum(["main", "subagent"]),
  startedAtMs: external_exports.number().int().nonnegative(),
  endedAtMs: external_exports.number().int().nonnegative(),
  model: external_exports.string().max(256).nullable(),
  name: external_exports.string().max(32768).nullable(),
  description: external_exports.string().max(32768).nullable()
}).strict();
var PluginHostWorkRecordPageV1Schema = external_exports.object({
  snapshot: PluginHostSnapshotV1Schema,
  records: external_exports.array(PluginHostWorkRecordV1Schema).max(100),
  nextCursor: cursor.nullable()
}).strict();
var PluginHostAgentV1Schema = external_exports.object({
  id: identifier,
  name: external_exports.string().max(512),
  teamKey: external_exports.string().max(128),
  teamName: external_exports.string().max(512).nullable(),
  title: external_exports.string().max(512),
  enabled: external_exports.boolean()
}).strict();
var PluginHostProjectV1Schema = external_exports.object({
  id: identifier,
  name: external_exports.string().max(512),
  archived: external_exports.boolean()
}).strict();
var PluginHostDirectoryPageV1Schema = external_exports.object({
  snapshot: PluginHostSnapshotV1Schema,
  entries: external_exports.array(external_exports.union([PluginHostAgentV1Schema, PluginHostProjectV1Schema])).max(100),
  nextCursor: cursor.nullable()
}).strict();
var PluginHostAgentPageV1Schema = external_exports.object({
  snapshot: PluginHostSnapshotV1Schema,
  entries: external_exports.array(PluginHostAgentV1Schema).max(100),
  nextCursor: cursor.nullable()
}).strict();
var PluginHostProjectPageV1Schema = external_exports.object({
  snapshot: PluginHostSnapshotV1Schema,
  entries: external_exports.array(PluginHostProjectV1Schema).max(100),
  nextCursor: cursor.nullable()
}).strict();
var PluginStateRecordV1Schema = external_exports.object({
  key: identifier,
  value: presentStateValue,
  sourceKind: external_exports.string().regex(/^[a-z][a-z0-9-]{0,31}$/).nullable().optional(),
  sourceId: identifier.nullable().optional(),
  revision: external_exports.number().int().nonnegative()
}).strict();
var PluginStateWriteRecordV1Schema = external_exports.object({
  key: identifier,
  value: presentStateValue,
  sourceKind: external_exports.string().regex(/^[a-z][a-z0-9-]{0,31}$/).nullable().optional(),
  sourceId: identifier.nullable().optional(),
  expectedRevision: external_exports.number().int().nonnegative().nullable().optional()
}).strict();
var PluginStateReadPageV1Schema = external_exports.object({
  records: external_exports.array(PluginStateRecordV1Schema).max(100),
  nextCursor: cursor.nullable()
}).strict();
var PluginStateBatchV1Schema = external_exports.object({
  namespace: identifier,
  records: external_exports.array(PluginStateWriteRecordV1Schema).min(1).max(100)
}).strict().refine((batch) => new Set(batch.records.map((record) => record.key)).size === batch.records.length);
var PluginStateDeleteBatchV1Schema = external_exports.object({
  namespace: identifier,
  keys: external_exports.array(identifier).min(1).max(100)
}).strict().refine((batch) => new Set(batch.keys).size === batch.keys.length);
var PluginStateBatchResultV1Schema = external_exports.object({
  written: external_exports.number().int().nonnegative().max(100),
  deleted: external_exports.number().int().nonnegative().max(100)
}).strict();
var PluginHostWorkChangedEventV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(1),
  kind: external_exports.literal("ext-capability-event"),
  capabilityId: external_exports.literal(PLUGIN_HOST_DATA_CAPABILITIES.workRecords),
  event: external_exports.literal("settled-changed"),
  generation,
  highWatermark: external_exports.string().max(40).nullable()
}).strict();
var PluginLegacyDataMigrationV1Schema = external_exports.object({
  id: external_exports.string().min(1).max(96).regex(/^[a-z0-9][a-z0-9._-]*$/),
  source: external_exports.string().min(1).max(96).regex(/^[a-z0-9][a-z0-9._-]*$/),
  target: external_exports.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._/-]*$/)
}).strict().refine((entry2) => !entry2.target.split("/").some((part) => part === "." || part === ".."));

var PROCESS_HELPER_LIMITS = Object.freeze({ helpers: 1, frameBytes: 64 * 1024, inFlightBytes: 256 * 1024 });
var safePath = external_exports.string().min(1).max(200).regex(/^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/).refine((value) => value.split("/").every((part) => part !== "." && part !== ".."));
var PluginProcessHelperDeclarationV1Schema = external_exports.object({
  id: external_exports.string().min(1).max(48).regex(/^[a-z][a-z0-9-]*$/),
  path: safePath,
  platform: external_exports.string().regex(/^[a-z0-9]+-[a-z0-9]+$/),
  sha256: external_exports.string().regex(/^[0-9a-f]{64}$/)
}).strict();
var PluginProcessHelperRequestV1Schema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("open"), helperId: external_exports.string().min(1).max(48) }).strict(),
  external_exports.object({ op: external_exports.literal("write"), helperId: external_exports.string().min(1).max(48), bytes: external_exports.string().min(1).max(PROCESS_HELPER_LIMITS.frameBytes * 2) }).strict(),
  external_exports.object({ op: external_exports.literal("read"), helperId: external_exports.string().min(1).max(48), maxBytes: external_exports.number().int().min(1).max(PROCESS_HELPER_LIMITS.frameBytes) }).strict(),
  external_exports.object({ op: external_exports.literal("close"), helperId: external_exports.string().min(1).max(48) }).strict()
]);
var PluginProcessHelperResponseV1Schema = external_exports.discriminatedUnion("state", [
  external_exports.object({ state: external_exports.literal("opened") }).strict(),
  external_exports.object({ state: external_exports.literal("data"), bytes: external_exports.string().max(PROCESS_HELPER_LIMITS.frameBytes * 2) }).strict(),
  external_exports.object({ state: external_exports.literal("empty") }).strict(),
  external_exports.object({ state: external_exports.literal("closed") }).strict()
]);

var FULL_TRUST_REACH = "完全信任級外掛的背景程式可連線到任何網路位置，TeamUQ 無法限制";
function categoryReview(permission2) {
  const entry2 = CATEGORY_DIRECTORY.find((candidate) => candidate.permission === permission2);
  if (entry2 === void 0) return { description: null };
  const description = `這個外掛會與你電腦上的其他外掛直接連線（只限它使用的功能：${entry2.displayName}），資料不經過 TeamUQ。`;
  return { description, fullTrustDescription: `${description}${FULL_TRUST_REACH}` };
}
var LOOPBACK_REVIEW = "連到您電腦上的本機位址（127.0.0.1）：只限它使用的外掛功能與它宣告的本機服務，資料不經過 TeamUQ";
var MEDIA_CAPTURE = "畫面的媒體擷取由 Core 的權限處理器放行，不是宿主 API 端點";
var BACKGROUND_RESIDENT_PERMISSION = "background:resident";
var PLUGIN_PERMISSIONS = [
  { id: "ui:view", kind: "host", surface: "view", revocable: false, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "在主視窗以分頁或整個頁面顯示外掛的畫面" },
  { id: "storage:plugin-data", kind: "host", surface: "view", revocable: false, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "讀寫外掛自己的資料資料夾（其他外掛看不到）" },
  { id: "assets:plugin-data", kind: "other", surface: "view", revocable: false, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: "資料資料夾素材以 tuqplugin:// 串流（本地輔助函式 assets.url），不經 IPC 端點", description: "串流播放外掛資料資料夾中的影片與素材" },
  { id: "network:fetch", kind: "other", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: "放行 network.allow 列出的網站，不是宿主 API 端點", description: "連線到下方列出的網站（其他網站一律被擋）", fullTrustDescription: "宣告外掛會連線的網站（列在下方）。完全信任級背景程式的網路 TeamUQ 無法限制，列出的網域只是外掛自己宣告的去向，不是限制" },
  { id: "network:loopback", kind: "other", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: LOOPBACK_REVIEW, fullTrustDescription: `${LOOPBACK_REVIEW}。${FULL_TRUST_REACH}` },
  { id: "media:microphone", kind: "other", surface: "view", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: MEDIA_CAPTURE, description: "使用麥克風（只在外掛畫面看得到時；切到別的分頁、最小化或被遮住後，TeamUQ 會停止錄音）" },
  { id: "media:camera", kind: "other", surface: "view", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: MEDIA_CAPTURE, description: "使用鏡頭（只在外掛畫面看得到時；切到別的分頁、最小化或被遮住後，TeamUQ 會停止擷取）" },
  { id: "media:system-output", kind: "other", surface: "view", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: MEDIA_CAPTURE, description: "取得系統輸出音訊來源（外掛必須自行提供擷取來源；TeamUQ 不會替外掛開啟 loopback 錄音）" },
  { id: "ai:chat", kind: "host", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "使用 TeamUQ 的 AI 對話（Codex）：外掛送出的文字與圖片會傳到您自己的 Codex（OpenAI）帳號並消耗您的額度；可串流互動或等單回合完整回覆；TeamUQ 只提供「對話」，不給外掛任何指令、檔案或其他工具，外掛也無法改這個限制" },
  { id: "input:text", kind: "host", surface: "view", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "登記成「目前的輸入對象」，接收 TeamUQ 送來的文字（您說的話、打的字或排程訊息）；只有畫面在前景時才收得到，您可以隨時撤銷" },
  { id: "program:conversation:dispatch", kind: "host", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "允許外掛用您電腦上的 AI 建立新對話並傳送第一段訊息；AI 可能依其工具權限讀寫檔案或連線網路，授權只限已核准的專案或工作項目，您可隨時撤銷" },
  { id: "program:conversation:read", kind: "host", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "允許外掛讀取它自己建立或已綁定的 AI 對話訊息；內容可能包含私人資料，您可隨時撤銷" },
  { id: "program:conversation:followup", kind: "host", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "允許外掛向它自己建立或已綁定且仍執行中的 AI 對話傳送後續訊息；AI 可能依其工具權限讀寫檔案或連線網路，您可隨時撤銷" },
  { id: "program:data:projects:read", kind: "host", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "允許外掛讀取專案名稱、描述與狀態等核准欄位，您可隨時撤銷" },
  { id: "program:data:projects:write", kind: "host", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "允許外掛建立、修改或封存專案的核准欄位，您可隨時撤銷" },
  { id: "program:data:milestones:read", kind: "host", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "允許外掛讀取里程碑名稱、描述與所屬專案等核准欄位，您可隨時撤銷" },
  { id: "program:data:milestones:write", kind: "host", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "允許外掛建立、修改或封存里程碑的核准欄位，您可隨時撤銷" },
  { id: "program:data:tasks:read", kind: "host", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "允許外掛讀取工作項目名稱、描述、所屬專案與目前狀態等核准欄位，您可隨時撤銷" },
  { id: "program:data:tasks:write", kind: "host", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "允許外掛建立、修改或移除工作項目中繼資料；此權限不包含指派、狀態或生命週期操作，您可隨時撤銷" },
  { id: "native:addons", kind: "other", surface: "backend", revocable: false, fullTrustOnly: true, coreSupported: true, legacy: null, nonEndpoint: "載入外掛自帶的 .node 原生模組（native.allowAddons），不是端點", description: "載入外掛自帶的原生程式（.node）。原生程式以您的使用者權限執行，Node 的檔案與行程限制對它形同虛設" },
  { id: "asset:pack", kind: "host", surface: "view", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "唯讀取用外掛宣告要用的資產包" },
  { id: "secrets:plugin", kind: "host", surface: "any", revocable: false, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "以作業系統加密保存外掛自己的祕密（例如 API 金鑰）" },
  { id: "settings:plugin", kind: "host", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "保存外掛自己的設定值" },
  { id: "process:spawn", kind: "host", surface: "backend", revocable: true, fullTrustOnly: true, coreSupported: true, legacy: null, nonEndpoint: null, description: "執行外掛套件內經核對雜湊的單一 helper；TeamUQ 只會啟動 manifest 宣告且已核准的固定檔案" },
  { id: "backend:invoke", kind: "other", surface: "view", revocable: false, fullTrustOnly: true, coreSupported: true, legacy: null, nonEndpoint: "舊版 manifest 相容欄位；backend.call 不需此授權", description: "舊版 manifest 相容欄位；backend.call 不需另行授權，仍受完全信任級組合外掛與 backendMethods 白名單限制" },
  { id: "store:browse", kind: "host", surface: "view", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "瀏覽 TeamUQ 角色商店：TeamUQ 會代你連到商店主機取得角色清單與預覽，商店主機會看到你的網路位址，不會看到你的帳號；你輸入的搜尋字只在這台電腦上比對，不會送出去。取得角色另需「讀取你加入的檔案」，而且每一次都會先由 TeamUQ 問你" },
  { id: "agent:avatar-read", kind: "host", surface: "view", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, description: "讀取已啟用 Agent 的現有頭像圖片；不會提供代理人名冊或檔案路徑，您可以隨時撤銷" },
  { id: "work-records:read", kind: "host", surface: "backend", revocable: true, fullTrustOnly: true, coreSupported: true, legacy: null, nonEndpoint: null, description: "允許外掛的背景程式讀取已結算的打卡紀錄（開始與結束時間、對應的 AI 代理、專案、對話與模型），並在有新的結算時收到通知；您可隨時撤銷" },
  { id: "agent-directory:read", kind: "host", surface: "backend", revocable: true, fullTrustOnly: true, coreSupported: true, legacy: null, nonEndpoint: null, description: "允許外掛的背景程式讀取 AI 團隊的代理名錄（名稱、職稱、所屬團隊與是否啟用）；您可隨時撤銷" },
  { id: "project-directory:read", kind: "host", surface: "backend", revocable: true, fullTrustOnly: true, coreSupported: true, legacy: null, nonEndpoint: null, description: "允許外掛的背景程式讀取專案名錄（專案名稱與是否封存）；您可隨時撤銷" },
  { id: "plugin-state:read", kind: "host", surface: "backend", revocable: true, fullTrustOnly: true, coreSupported: true, legacy: null, nonEndpoint: null, description: "允許外掛的背景程式讀取它自己存在 TeamUQ 資料庫裡的狀態紀錄（其他外掛看不到）；您可隨時撤銷" },
  { id: "plugin-state:write", kind: "host", surface: "backend", revocable: true, fullTrustOnly: true, coreSupported: true, legacy: null, nonEndpoint: null, description: "允許外掛的背景程式在 TeamUQ 資料庫裡寫入或刪除它自己的狀態紀錄（其他外掛看不到）；您可隨時撤銷" },
  { id: "data:legacy-migrate", kind: "other", surface: "backend", revocable: true, fullTrustOnly: true, coreSupported: true, legacy: null, nonEndpoint: "安裝時依 data.legacyMigrations 搬移舊資料，不是端點", description: "安裝時，把舊版 TeamUQ 替這個外掛保留的資料搬到外掛自己的資料資料夾（只搬外掛宣告、且 TeamUQ 認得的項目）" },
  { id: "background:resident", kind: "other", surface: "backend", revocable: true, fullTrustOnly: true, optIn: true, coreSupported: true, legacy: null, nonEndpoint: "Core 依此決定背景程式是否常駐（啟動時預熱、不閒置卸載），不是宿主 API 端點", description: "讓外掛的背景程式在您關閉它的畫面後仍持續執行（只要 TeamUQ 還開著），會持續使用記憶體與處理器；同時最多 2 個外掛可以這樣執行，您可隨時關閉" },
  { id: "cap:stt", kind: "category", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, ...categoryReview("cap:stt") },
  { id: "cap:tts", kind: "category", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, ...categoryReview("cap:tts") },
  { id: "cap:audio", kind: "category", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, ...categoryReview("cap:audio") },
  { id: "cap:image", kind: "category", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, ...categoryReview("cap:image") },
  { id: "cap:video", kind: "category", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, ...categoryReview("cap:video") },
  { id: "cap:doc", kind: "category", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, ...categoryReview("cap:doc") },
  { id: "cap:text", kind: "category", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, ...categoryReview("cap:text") },
  { id: "cap:memory", kind: "category", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, ...categoryReview("cap:memory") },
  { id: "cap:personal", kind: "category", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, ...categoryReview("cap:personal") },
  { id: "cap:notify", kind: "category", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, ...categoryReview("cap:notify") },
  { id: "cap:web", kind: "category", surface: "any", revocable: true, fullTrustOnly: false, coreSupported: true, legacy: null, nonEndpoint: null, ...categoryReview("cap:web") }
];
var PERMISSION_FAMILIES = [
  { prefix: "ui:", revocable: false, viewOnly: true },
  { prefix: "media:", revocable: true, viewOnly: true },
  { prefix: "network:", revocable: true, viewOnly: false },
  { prefix: "ai:", revocable: true, viewOnly: false },
  { prefix: "input:", revocable: true, viewOnly: false },
  { prefix: "backend:", revocable: false, viewOnly: false },
  { prefix: "process:", revocable: true, viewOnly: false },
  { prefix: "assets:", revocable: false, viewOnly: true },
  { prefix: "store:", revocable: true, viewOnly: true },
  { prefix: "program:", revocable: true, viewOnly: false },
  { prefix: "cap:", revocable: true, viewOnly: false }
];
var rows = PLUGIN_PERMISSIONS;
var families = PERMISSION_FAMILIES;
var familyCovers = (id7, flag) => families.some((family) => family[flag] && id7.startsWith(family.prefix));
var idsOf = (selected) => Object.freeze(selected.map((row) => row.id));
var recognized = (row) => row.kind !== "category" || row.coreSupported;
var manifestRows = rows.filter(recognized);
var PLUGIN_PERMISSION_LISTS = Object.freeze({
  known: idsOf(manifestRows),
  coreSupported: idsOf(manifestRows.filter((row) => row.coreSupported)),
  revocablePrefixes: Object.freeze(families.filter((family) => family.revocable).map((family) => family.prefix)),
  revocableExact: idsOf(manifestRows.filter((row) => row.revocable && !familyCovers(row.id, "revocable"))),
  viewOnlyPrefixes: Object.freeze(families.filter((family) => family.viewOnly).map((family) => family.prefix)),
  optIn: idsOf(manifestRows.filter((row) => row.optIn === true))
});
var byId2 = new Map(rows.map((row) => [row.id, row]));
var optInIds = new Set(PLUGIN_PERMISSION_LISTS.optIn);

var PLUGIN_MANIFEST_V2_SCHEMA_VERSION = 2;
var KNOWN_PLUGIN_PERMISSIONS = PLUGIN_PERMISSION_LISTS.known;
var CORE_SUPPORTED_PLUGIN_PERMISSIONS = PLUGIN_PERMISSION_LISTS.coreSupported;
var BACKEND_UI_ONLY_PERMISSION_PREFIXES = PLUGIN_PERMISSION_LISTS.viewOnlyPrefixes;
var REVOCABLE_PLUGIN_PERMISSION_PREFIXES = PLUGIN_PERMISSION_LISTS.revocablePrefixes;
var REVOCABLE_PLUGIN_EXACT_PERMISSIONS = PLUGIN_PERMISSION_LISTS.revocableExact;
var CORE_SUPPORTED_PRESENTATIONS = Object.freeze(["tab", "fullpage", "settings"]);
var CORE_IMPLEMENTED_PLATFORM_IDS = Object.freeze(["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64"]);
var PLATFORM_ID_PATTERN = /^[a-z0-9]+-[a-z0-9]+$/;
var DOTTED_PATTERN = /^\d{1,6}(?:\.\d{1,6}){0,2}$/;
var MAX_CORE_PATTERN = /^[1-9][0-9]*\.x$/;
var UI_VIEW_PERMISSION = "ui:view";
var PRESENTATIONS = ["tab", "window", "fullpage", "overlay", "settings"];
var ManifestCapabilityIdSchema = external_exports.string().max(96).refine((value) => CAPABILITY_PATTERN.test(value) || value.endsWith("@0") && isOfficialCategoryId(value), { message: "must be a capability id supported by the manifest syntax" });
function categoryEntryForManifestCapability(capability) {
  if (capability.endsWith("@0") && isOfficialCategoryId(capability)) return categoryEntry(capability.replace(/@0$/u, "@1"));
  return categoryEntry(capability);
}
var UNIFORM_GPU_CATEGORY_IDS = new Set([...new Set(GROUP_DIRECTORY.map(({ category }) => category))].filter((category) => {
  const groups = GROUP_DIRECTORY.filter((entry2) => entry2.category === category);
  return groups.length > 0 && groups.every((entry2) => entry2.resourceClass === "gpu");
}));
var unique4 = (values) => new Set(values).size === values.length;
function isSafeRelativePath(value) {
  if (value.length === 0 || value.length > 200) return false;
  if (!/^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== "..");
}
var relativePath = external_exports.string().refine(isSafeRelativePath, { message: "must be a safe relative path" });
var HostApiSchema = external_exports.object({ id: external_exports.string().min(3).max(64).regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/), range: external_exports.string().regex(RANGE_PATTERN) }).strict();
var pngPath = relativePath.refine((value) => /\.png$/iu.test(value), { message: "icon must be a .png file" });
var ViewSchema = external_exports.object({
  id: external_exports.string().regex(IDENTIFIER_PATTERN).max(32),
  title: external_exports.string().min(1).max(48).refine(isPlainText, { message: "must be plain text" }),
  icon: relativePath.optional(),
  entry: relativePath,
  remote: external_exports.boolean().optional(),
  presentations: external_exports.array(external_exports.enum(PRESENTATIONS)).min(1).max(5),
  defaultPresentation: external_exports.enum(PRESENTATIONS),
  window: external_exports.object({
    width: external_exports.number().int().min(160).max(8192),
    height: external_exports.number().int().min(120).max(8192),
    minWidth: external_exports.number().int().min(160).max(8192).optional(),
    minHeight: external_exports.number().int().min(120).max(8192).optional(),
    resizable: external_exports.boolean().optional()
  }).strict().optional()
}).strict().superRefine((view, context) => {
  if (!unique4(view.presentations)) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["presentations"], message: "presentations must not contain duplicates" });
  if (!view.presentations.includes(view.defaultPresentation)) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["defaultPresentation"], message: "defaultPresentation must be one of presentations" });
  if (view.presentations.includes("settings") && (view.presentations.length !== 1 || view.window !== void 0)) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["presentations"], message: "a settings view has no other presentation and no window" });
});
var ProvidesSchema = external_exports.object({
  capability: ManifestCapabilityIdSchema,
  permission: external_exports.string().regex(PERMISSION_PATTERN),
  transport: external_exports.literal("link"),
  maxSessions: external_exports.number().int().min(1).max(16),
  dataClass: DataClassSchema
}).strict();
var PlatformSchema = external_exports.object({
  id: external_exports.string().regex(PLATFORM_ID_PATTERN),
  minOs: external_exports.string().regex(DOTTED_PATTERN).optional(),
  minGlibc: external_exports.string().regex(DOTTED_PATTERN).optional()
}).strict();
var NativeSchema = external_exports.object({
  allowAddons: external_exports.boolean(),
  files: external_exports.array(external_exports.object({ path: relativePath, platform: external_exports.string().regex(PLATFORM_ID_PATTERN) }).strict()).max(64)
}).strict();
var ResourcesSchema = external_exports.object({
  memoryMB: external_exports.number().int().min(1).max(8192),
  cpuThreads: external_exports.number().int().min(1).max(32),
  maxSessions: external_exports.number().int().min(1).max(16),
  idleUnloadSec: external_exports.number().int().min(0).max(86400),
  bootTimeoutSec: external_exports.number().int().min(1).max(120)
}).strict();
var RESIDENCY_LEVELS = ["on-demand", "warm", "resident"];
var RESIDENCY_ORDER = Object.freeze({ "on-demand": 0, warm: 1, resident: 2 });
var ResidencySchema = external_exports.object({
  default: external_exports.enum(RESIDENCY_LEVELS),
  max: external_exports.enum(RESIDENCY_LEVELS).optional(),
  warmKeepSec: external_exports.number().int().min(30).max(3600).optional()
}).strict().superRefine((residency, context) => {
  if (residency.max !== void 0 && RESIDENCY_ORDER[residency.default] > RESIDENCY_ORDER[residency.max]) {
    context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["max"], message: "max residency must be at least the default residency" });
  }
});
var BACKEND_RESOURCE_DEFAULTS = Object.freeze({ memoryMB: 256, cpuThreads: 1, maxSessions: 1, idleUnloadSec: 300, bootTimeoutSec: 10 });
var BACKEND_RESOURCE_CORE_LIMITS = Object.freeze({ memoryMB: 1024, cpuThreads: 4, maxSessions: 4, idleUnloadSecMin: 5, idleUnloadSecMax: 3600, bootTimeoutSec: 60 });
var BACKEND_ENTRY_PATTERN = /\.(?:mjs|cjs)$/;
var AssetPackRefSchema = external_exports.object({
  id: external_exports.string().regex(IDENTIFIER_PATTERN).min(3).max(96),
  range: external_exports.string().regex(RANGE_PATTERN),
  required: external_exports.boolean()
}).strict();
var PluginManifestV2Schema = external_exports.object({
  schemaVersion: external_exports.literal(PLUGIN_MANIFEST_V2_SCHEMA_VERSION),
  kind: external_exports.enum(["plugin", "asset-pack"]),
  id: external_exports.string().min(3).max(96).regex(IDENTIFIER_PATTERN),
  name: external_exports.string().min(1).max(96).refine(isPlainText, { message: "must be plain text" }),
  version: external_exports.string().regex(VERSION_PATTERN),
  publisher: external_exports.string().regex(IDENTIFIER_PATTERN).min(2).max(48),
  description: external_exports.string().max(512).refine(isPlainText, { message: "must be plain text" }).optional(),
  icon: pngPath.optional(),
  pluginApi: external_exports.string().regex(RANGE_PATTERN),
  hostApis: external_exports.array(HostApiSchema).max(16).default([]),
  minCoreVersion: external_exports.string().regex(RANGE_PATTERN),
  maxCoreVersion: external_exports.string().regex(MAX_CORE_PATTERN).optional(),
  platforms: external_exports.array(PlatformSchema).max(8).default([]),
  trustTier: external_exports.enum(["sandboxed", "full-trust"]).default("sandboxed"),
  entry: external_exports.object({ ui: relativePath.optional(), backend: relativePath.optional() }).strict().default({}),
  backendMethods: external_exports.array(external_exports.string().min(1).max(64).regex(/^[A-Za-z0-9._@-]+$/)).min(1).max(32).optional(),
  processHelper: PluginProcessHelperDeclarationV1Schema.optional(),
  native: NativeSchema.optional(),
  resources: ResourcesSchema.optional(),
  residency: ResidencySchema.optional(),
  provides: external_exports.array(ProvidesSchema).max(16).default([]),
  requiredCapabilities: external_exports.array(ManifestCapabilityIdSchema).max(32).default([]),
  optionalCapabilities: external_exports.array(ManifestCapabilityIdSchema).max(32).default([]),
  assetPacks: external_exports.array(AssetPackRefSchema).max(16).default([]),
  assetPackPrefixes: external_exports.array(external_exports.string().min(3).max(90)).max(4).default([]),
  settingsSchema: PluginSettingsSchemaSchema.optional(),
  permissions: external_exports.array(external_exports.string().regex(PERMISSION_PATTERN)).max(64).default([]),
  capabilityGroups: external_exports.record(CategoryIdSchema, external_exports.array(GroupIdSchema).min(1).max(16)).refine((groups) => Object.keys(groups).length <= 16, { message: "capabilityGroups may name at most 16 categories" }).optional(),
  network: external_exports.object({ allow: external_exports.array(external_exports.string().url().max(200)).max(32), loopbackServices: external_exports.array(LoopbackServiceSchema).max(LOOPBACK_SERVICE_LIMITS.maxServices).optional() }).strict().default({ allow: [] }),
  contributes: external_exports.object({ views: external_exports.array(ViewSchema).max(3) }).strict().default({ views: [] }),
  data: external_exports.object({ uninstall: external_exports.enum(["keep", "delete", "ask"]), legacyMigrations: external_exports.array(PluginLegacyDataMigrationV1Schema).max(8).default([]) }).strict().default({ uninstall: "ask", legacyMigrations: [] }),
  provenance: external_exports.object({ upstream: external_exports.string().max(300), upstreamSha256: external_exports.string().regex(/^[0-9a-f]{64}$/), license: external_exports.string().max(64) }).strict().optional()
}).strict().superRefine((manifest, context) => {
  const fail3 = (path, message) => {
    context.addIssue({ code: external_exports.ZodIssueCode.custom, path: [path], message });
  };
  for (const [field, values] of [
    ["requiredCapabilities", manifest.requiredCapabilities],
    ["hostApis", manifest.hostApis.map((entry2) => entry2.id)],
    ["optionalCapabilities", manifest.optionalCapabilities],
    ["permissions", manifest.permissions],
    ["network", manifest.network.allow],
    ["provides", manifest.provides.map((entry2) => entry2.capability)],
    ["platforms", manifest.platforms.map((entry2) => entry2.id)],
    ["assetPacks", manifest.assetPacks.map((entry2) => entry2.id)],
    ["assetPackPrefixes", manifest.assetPackPrefixes],
    ["views", manifest.contributes.views.map((view) => view.id)]
  ]) {
    if (!unique4(values)) fail3(field, `${field} must not contain duplicates`);
  }
  const capabilities = [...manifest.requiredCapabilities, ...manifest.optionalCapabilities, ...manifest.provides.map((entry2) => entry2.capability)];
  if (!unique4(capabilities)) fail3("provides", "a capability may appear only once across provides, requiredCapabilities and optionalCapabilities");
  const fullTrust = manifest.trustTier === "full-trust";
  if (manifest.kind === "asset-pack") {
    if (manifest.backendMethods !== void 0) fail3("backendMethods", "asset-pack cannot declare backendMethods");
    if (manifest.processHelper !== void 0) fail3("processHelper", "asset-pack cannot declare processHelper");
    if (fullTrust) fail3("trustTier", "asset-pack cannot be full-trust");
    if (manifest.icon !== void 0) fail3("icon", "asset-pack cannot declare icon");
    if (manifest.entry.ui !== void 0 || manifest.entry.backend !== void 0) fail3("entry", "asset-pack cannot declare entry");
    if (manifest.native !== void 0 || manifest.resources !== void 0) fail3("native", "asset-pack cannot declare native or resources");
    if (manifest.residency !== void 0) fail3("residency", "asset-pack cannot declare residency");
    if (manifest.provides.length > 0 || manifest.permissions.length > 0 || manifest.assetPacks.length > 0) fail3("permissions", "asset-pack cannot declare provides, permissions or assetPacks");
    if (manifest.capabilityGroups !== void 0 || (manifest.network.loopbackServices?.length ?? 0) > 0) fail3("network", "asset-pack cannot declare capabilityGroups or loopbackServices");
    if (manifest.assetPackPrefixes.length > 0 || manifest.settingsSchema !== void 0) fail3("assetPackPrefixes", "asset-pack cannot declare assetPackPrefixes or settingsSchema");
    if (manifest.contributes.views.length > 0) fail3("contributes", "asset-pack cannot contribute views");
    return;
  }
  if (manifest.provenance !== void 0) fail3("provenance", "provenance is only allowed on asset-pack");
  if (manifest.residency !== void 0 && manifest.provides.length === 0) fail3("residency", "residency requires a plugin that provides a capability");
  if (manifest.entry.ui === void 0 && manifest.entry.backend === void 0) fail3("entry", "plugin must declare entry.ui or entry.backend");
  if (!fullTrust && manifest.entry.backend !== void 0) fail3("entry", "entry.backend requires full-trust");
  if (fullTrust && manifest.entry.backend === void 0) fail3("entry", "full-trust plugin must declare entry.backend");
  const composed = fullTrust && manifest.entry.ui !== void 0 && manifest.entry.backend !== void 0;
  if (manifest.backendMethods !== void 0 && !composed) fail3("backendMethods", "backendMethods requires a full-trust plugin with both entry.ui and entry.backend");
  if (composed && manifest.backendMethods === void 0) fail3("backendMethods", "a composed plugin must declare backendMethods");
  if (manifest.backendMethods !== void 0 && !unique4(manifest.backendMethods)) fail3("backendMethods", "backendMethods must not contain duplicates");
  if (manifest.processHelper !== void 0 && (!fullTrust || !manifest.permissions.includes("process:spawn"))) fail3("processHelper", "processHelper requires a full-trust plugin with process:spawn");
  if (!composed && manifest.permissions.includes("backend:invoke")) fail3("permissions", "backend:invoke requires a composed plugin");
  if (manifest.entry.backend !== void 0 && !BACKEND_ENTRY_PATTERN.test(manifest.entry.backend)) fail3("entry", "entry.backend must be an .mjs or .cjs file");
  if (fullTrust) {
    if (!composed && manifest.permissions.some((permission2) => BACKEND_UI_ONLY_PERMISSION_PREFIXES.some((prefix) => permission2.startsWith(prefix)))) fail3("permissions", "backend-only plugins have no view and cannot request ui, media or assets permissions");
    if (manifest.native !== void 0 && manifest.platforms.length === 0) fail3("platforms", "native files require an explicit platforms list");
    if (manifest.native !== void 0 && !unique4(manifest.native.files.map((file) => `${file.platform}:${file.path}`))) fail3("native", "native files must not contain duplicates");
    if (manifest.native?.allowAddons === true !== manifest.permissions.includes("native:addons")) fail3("permissions", "native.allowAddons and the native:addons permission must be declared together");
    if (manifest.native?.files.some((file) => file.path === manifest.entry.backend)) fail3("native", "the backend entry cannot be a native file");
  } else if (manifest.permissions.includes("native:addons")) fail3("permissions", "native:addons requires full-trust");
  if (manifest.permissions.includes(BACKGROUND_RESIDENT_PERMISSION)) {
    if (!fullTrust) fail3("permissions", "background:resident requires full-trust");
    if (manifest.entry.backend === void 0) fail3("permissions", "background:resident requires entry.backend");
    if (manifest.provides.length > 0) fail3("permissions", "background:resident cannot be combined with provides; capability providers use residency");
  }
  if (!fullTrust && (manifest.native !== void 0 || manifest.resources !== void 0)) fail3("trustTier", "native and resources require full-trust");
  if (!fullTrust && manifest.provides.length > 0) fail3("provides", "a sandboxed plugin cannot provide a capability");
  for (const provided of manifest.provides) {
    const category = categoryEntryForManifestCapability(provided.capability);
    if (category !== void 0 && provided.permission !== category.permission) fail3("provides", `${provided.capability} must be gated by ${category.permission}`);
  }
  const loopbackServices = manifest.network.loopbackServices ?? [];
  if (!unique4(loopbackServices.map((service) => service.id))) fail3("network", "loopbackServices ids must be unique");
  const hasLoopback = manifest.permissions.includes("network:loopback");
  const usesCategory = capabilities.some((capability) => categoryEntryForManifestCapability(capability) !== void 0);
  if (hasLoopback && !usesCategory && loopbackServices.length === 0) fail3("permissions", "network:loopback requires at least one link category or one network.loopbackServices entry");
  if (!hasLoopback && usesCategory) fail3("permissions", "using or providing a link category requires network:loopback");
  if (!hasLoopback && loopbackServices.length > 0) fail3("permissions", "network.loopbackServices requires network:loopback");
  for (const [category, groups] of Object.entries(manifest.capabilityGroups ?? {})) {
    if (!unique4(groups)) fail3("capabilityGroups", `capabilityGroups of ${category} must not contain duplicates`);
    for (const group of groups) {
      if (categoryEntry(category)?.coreOnlyGroups.includes(group) === true) fail3("capabilityGroups", `group ${group} of ${category} is reserved for Core and cannot be declared`);
    }
  }
  const settingsViews = manifest.contributes.views.filter((view) => view.presentations.includes("settings"));
  if (settingsViews.length > 1) fail3("contributes", "a plugin may contribute only one settings view");
  if (settingsViews.length > 0 && manifest.settingsSchema !== void 0) fail3("settingsSchema", "a plugin with a settings view cannot also declare settingsSchema");
  if (manifest.settingsSchema !== void 0 && !manifest.permissions.includes(SETTINGS_SCHEMA_PERMISSION)) fail3("permissions", `settingsSchema requires the ${SETTINGS_SCHEMA_PERMISSION} permission`);
  if (manifest.data.legacyMigrations.length > 0 && !manifest.permissions.includes("data:legacy-migrate")) fail3("permissions", "data.legacyMigrations requires data:legacy-migrate");
  if (manifest.data.legacyMigrations.length > 0 && !fullTrust) fail3("trustTier", "data.legacyMigrations requires full-trust");
  if (!unique4(manifest.data.legacyMigrations.map((entry2) => entry2.id)) || !unique4(manifest.data.legacyMigrations.map((entry2) => entry2.source)) || !unique4(manifest.data.legacyMigrations.map((entry2) => entry2.target))) fail3("data", "legacy data migration ids, sources and targets must be unique");
  for (const prefix of manifest.assetPackPrefixes) {
    if (!isAssetPackPrefixOf(manifest.id, prefix)) fail3("assetPackPrefixes", `prefix ${prefix} must start with this plugin's own namespace ${assetPackNamespaceOf(manifest.id) ?? "(none: the plugin id has no publisher part)"}`);
  }
  if (manifest.assetPackPrefixes.length > 0 && !manifest.permissions.includes("asset:pack")) fail3("permissions", "assetPackPrefixes require the asset:pack permission");
  if (manifest.contributes.views.length > 0 && manifest.entry.ui === void 0) fail3("contributes", "views require entry.ui");
  if (manifest.assetPacks.length > 0 && !manifest.permissions.includes("asset:pack")) fail3("permissions", "assetPacks require the asset:pack permission");
  if (manifest.network.allow.length > 0 && !manifest.permissions.includes("network:fetch") && !manifest.permissions.includes("network:loopback")) fail3("permissions", "network.allow requires the network:fetch permission");
  const platformIds = new Set(manifest.platforms.map((entry2) => entry2.id));
  for (const file of manifest.native?.files ?? []) {
    if (platformIds.size > 0 && !platformIds.has(file.platform)) fail3("native", `native file platform ${file.platform} is not listed in platforms`);
  }
  for (const view of manifest.contributes.views) {
    for (const presentation of view.presentations) {
      if (!manifest.permissions.includes(UI_VIEW_PERMISSION)) fail3("permissions", `presentation ${presentation} requires ${UI_VIEW_PERMISSION}`);
    }
  }
});

var AI_CHAT_PERMISSION = "ai:chat";
var PLUGIN_AI_CHANNELS = Object.freeze({
  REQUEST: "plugin-view:ai",
  EVENT: "plugin-view:ai-event"
});
var AI_CHAT_LIMITS = Object.freeze({
  systemChars: 16e3,
  transcriptLines: 40,
  transcriptLineChars: 8e3,
  transcriptChars: 6e4,
  inputChars: 8e3,
  imageBytes: 2 * 1024 * 1024,
  replyChars: 32e3,
  sessionsPerPlugin: 1,
  sessionsTotal: 8,
  concurrentTurnsTotal: 4,
  turnsPerMinute: 20,
  turnsPerHour: 400,
  turnTimeoutMs: 3e5,
  attachGraceMs: 6e4,
  quotaCooldownMs: 5 * 6e4,
  hiddenWindowMs: 2 * 6e4,
  hiddenOpensPerInput: 2,
  hiddenTurnsPerInput: 2
});
var AI_CHAT_EFFORTS = Object.freeze(["minimal", "low", "medium", "high", "xhigh"]);
var AI_CHAT_ERROR_CODES = Object.freeze([
  "plugin_not_active",
  "not_granted",
  "request_invalid",
  "input_too_large",
  "provider_not_found",
  "provider_not_ready",
  "task_not_found",
  "execution_unavailable",
  "model_unavailable",
  "unsupported_image",
  "session_limit",
  "session_not_found",
  "turn_in_progress",
  "empty_reply",
  "empty_response",
  "interrupted",
  "turn_timeout",
  "deadline_exceeded",
  "cancelled",
  "response_too_large",
  "response_unavailable",
  "submit_rejected",
  "one_shot_failed",
  "provider_error",
  "session_closed",
  "event_stream_error",
  "cleanup_failed",
  "rate_limited",
  "quota_exhausted",
  "busy",
  "view_not_visible",
  "unavailable"
]);
var AiChatSessionIdSchema = external_exports.string().regex(/^[1-9][0-9]{0,18}$/).refine((value) => {
  try {
    return BigInt(value) <= 9223372036854775807n;
  } catch {
    return false;
  }
});
var sessionId2 = AiChatSessionIdSchema;
var providerId2 = external_exports.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
var modelId2 = external_exports.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/);
var effort = external_exports.enum(AI_CHAT_EFFORTS);
var line = external_exports.object({ role: external_exports.enum(["user", "assistant"]), text: external_exports.string().max(AI_CHAT_LIMITS.transcriptLineChars) }).strict();
var sessionInput = external_exports.string().max(AI_CHAT_LIMITS.inputChars);
var AiChatImageSchema = external_exports.object({
  mime: external_exports.enum(["image/jpeg", "image/png"]),
  data: external_exports.custom((value) => value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= AI_CHAT_LIMITS.imageBytes)
}).strict();
var AiChatCompleteFreshRequestSchema = external_exports.object({
  op: external_exports.literal("complete"),
  taskId: sessionId2.optional(),
  providerId: providerId2.optional(),
  modelId: modelId2.optional(),
  effort: effort.optional(),
  system: external_exports.string().min(1).max(AI_CHAT_LIMITS.systemChars),
  transcript: external_exports.array(line).max(AI_CHAT_LIMITS.transcriptLines).optional(),
  text: sessionInput,
  image: AiChatImageSchema.optional()
}).strict();
var AiChatCompleteExistingRequestSchema = external_exports.object({
  op: external_exports.literal("complete"),
  taskId: sessionId2.optional(),
  sessionId: sessionId2,
  modelId: modelId2.optional(),
  effort: effort.optional(),
  text: sessionInput,
  image: AiChatImageSchema.optional()
}).strict();
var AiChatCompleteRequestSchema = external_exports.union([AiChatCompleteFreshRequestSchema, AiChatCompleteExistingRequestSchema]).refine((value) => value.text.trim() !== "" || value.image !== void 0, { message: "a turn needs text or an image" });
var AiChatCompleteInputWireSchema = external_exports.object({
  op: external_exports.literal("complete"),
  taskId: sessionId2.optional(),
  sessionId: sessionId2.optional(),
  providerId: providerId2.optional(),
  modelId: modelId2.optional(),
  effort: effort.optional(),
  system: external_exports.string().min(1).max(AI_CHAT_LIMITS.systemChars).optional(),
  transcript: external_exports.array(line).max(AI_CHAT_LIMITS.transcriptLines).optional(),
  text: sessionInput,
  image: AiChatImageSchema.optional()
}).strict();
var AiChatRequestVariants = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("getOptions") }).strict(),
  external_exports.object({
    op: external_exports.literal("openSession"),
    taskId: sessionId2.optional(),
    providerId: providerId2.optional(),
    modelId: modelId2.optional(),
    effort: effort.optional(),
    system: external_exports.string().min(1).max(AI_CHAT_LIMITS.systemChars),
    transcript: external_exports.array(line).max(AI_CHAT_LIMITS.transcriptLines).optional()
  }).strict(),
  external_exports.object({ op: external_exports.literal("send"), sessionId: sessionId2, text: external_exports.string().max(AI_CHAT_LIMITS.inputChars), image: AiChatImageSchema.optional() }).strict(),
  external_exports.object({ op: external_exports.literal("interrupt"), sessionId: sessionId2 }).strict(),
  external_exports.object({ op: external_exports.literal("close"), sessionId: sessionId2 }).strict(),
  external_exports.object({ op: external_exports.literal("attachSession"), sessionId: sessionId2, taskId: sessionId2.optional() }).strict(),
  AiChatCompleteInputWireSchema
]);
var AiChatRequestSchema = AiChatRequestVariants.superRefine((value, ctx) => {
  if (value.op === "send" && value.text.trim() === "" && value.image === void 0) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, message: "a turn needs text or an image" });
  if (value.op === "complete") {
    if (value.sessionId === void 0 && value.system === void 0) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, message: "fresh completion needs system context", path: ["system"] });
    if (value.sessionId !== void 0 && (value.providerId !== void 0 || value.system !== void 0 || value.transcript !== void 0)) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, message: "existing Session owns its provider context", path: ["sessionId"] });
    if (value.text.trim() === "" && value.image === void 0) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, message: "a turn needs text or an image" });
  }
});
var modelView = external_exports.object({
  id: external_exports.string().max(96),
  label: external_exports.string().max(96),
  efforts: external_exports.array(external_exports.string().max(16)).max(8),
  defaultEffort: external_exports.string().max(16).nullable(),
  supportsImages: external_exports.boolean(),
  isDefault: external_exports.boolean()
}).strict();
var AiChatProviderViewSchema = external_exports.object({
  id: providerId2,
  label: external_exports.string().max(48),
  state: external_exports.enum(["ready", "not_installed", "not_logged_in", "unsupported_version", "unavailable", "not_supported_yet"]),
  models: external_exports.array(modelView).max(32)
}).strict();
var AiChatOptionsSchema = external_exports.object({
  providers: external_exports.array(AiChatProviderViewSchema).max(8),
  defaultProviderId: providerId2.nullable(),
  limits: external_exports.object({
    systemChars: external_exports.number().int(),
    transcriptLines: external_exports.number().int(),
    transcriptChars: external_exports.number().int(),
    inputChars: external_exports.number().int(),
    imageBytes: external_exports.number().int(),
    turnsPerMinute: external_exports.number().int()
  }).strict(),
  quota: external_exports.object({ state: external_exports.enum(["ok", "exhausted"]), retryAfterMs: external_exports.number().int().nonnegative().nullable() }).strict()
}).strict();
var effective = external_exports.object({ providerId: providerId2, modelId: external_exports.string().max(96), effort: external_exports.string().max(16).nullable() }).strict();
var AiChatOpenedSchema = external_exports.object({ sessionId: sessionId2, effective }).strict();
var AiChatSentSchema = external_exports.object({ turnId: external_exports.string().regex(/^[0-9a-f]{16}$/) }).strict();
var AiChatCompleteResultSchema = external_exports.object({
  sessionId: sessionId2,
  requestId: external_exports.string().min(1).max(512),
  text: external_exports.string().max(AI_CHAT_LIMITS.replyChars),
  providerTurnId: external_exports.string().min(1).max(512).nullable(),
  historySaved: external_exports.enum(["pending", "saved"])
}).strict();
var AiChatFailureSchema = external_exports.object({
  kind: external_exports.literal("failed"),
  code: external_exports.enum(["provider_unavailable", "unsupported_version", "quota_exhausted", "stalled", "provider_error", "empty_reply", "session_closed", "reply_too_long", "turn_timeout", "access_revoked"]),
  retryable: external_exports.boolean(),
  fallbackUsed: external_exports.boolean(),
  partialDelivered: external_exports.boolean()
}).strict();
var AiChatTurnEventSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("started") }).strict(),
  external_exports.object({ kind: external_exports.literal("textDelta"), text: external_exports.string().max(AI_CHAT_LIMITS.replyChars) }).strict(),
  external_exports.object({ kind: external_exports.literal("contentSaved"), sequenceNo: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
  external_exports.object({ kind: external_exports.literal("completed") }).strict(),
  external_exports.object({ kind: external_exports.literal("interrupted") }).strict(),
  AiChatFailureSchema
]);
var AiChatAttachedSchema = external_exports.object({
  sessionId: sessionId2,
  effective,
  turn: external_exports.object({ turnId: external_exports.string().regex(/^[0-9a-f]{16}$/), text: external_exports.string().max(AI_CHAT_LIMITS.replyChars), terminal: AiChatTurnEventSchema.nullable() }).strict().nullable()
}).strict();
var AiChatEnvelopeSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ ok: external_exports.literal(true), value: external_exports.unknown() }).strict(),
  external_exports.object({ ok: external_exports.literal(false), error: external_exports.enum(AI_CHAT_ERROR_CODES) }).strict()
]);
var AiChatViewEventSchema = external_exports.object({ sessionId: sessionId2, turnId: external_exports.string().regex(/^[0-9a-f]{16}$/), event: AiChatTurnEventSchema }).strict();
var AiChatUsageSchema = external_exports.object({
  activeSessions: external_exports.number().int().nonnegative(),
  sessionsOpened: external_exports.number().int().nonnegative(),
  turns: external_exports.number().int().nonnegative(),
  imageTurns: external_exports.number().int().nonnegative(),
  failedTurns: external_exports.number().int().nonnegative(),
  rateLimited: external_exports.number().int().nonnegative(),
  inputChars: external_exports.number().int().nonnegative(),
  outputChars: external_exports.number().int().nonnegative(),
  lastTurnAt: external_exports.string().max(40).nullable()
}).strict();

var PLUGIN_STORE_ERROR_CODES = Object.freeze([
  "store_unavailable",
  "store_untrusted",
  "store_entry_unknown",
  "store_not_owned",
  "store_not_free",
  "store_withdrawn",
  "store_incompatible",
  "store_too_large",
  "store_disk_insufficient",
  "store_download_failed",
  "store_hash_mismatch",
  "store_busy",
  "store_signin_required"
]);
var PLUGIN_STORE_LIMITS = Object.freeze({
  pageSize: 50,
  queryChars: 100,
  queryTags: 8,
  tagChars: 48,
  installedEntries: 200
});
var entryId = external_exports.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/);
var packId = external_exports.string().min(3).max(96);
var version = external_exports.string().max(32);
var bytes = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var PluginStoreReadRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("status"), refresh: external_exports.boolean().optional() }).strict(),
  external_exports.object({
    op: external_exports.literal("list"),
    text: external_exports.string().max(PLUGIN_STORE_LIMITS.queryChars).optional(),
    tags: external_exports.array(external_exports.string().min(1).max(PLUGIN_STORE_LIMITS.tagChars)).max(PLUGIN_STORE_LIMITS.queryTags).optional(),
    cursor: external_exports.string().max(16).nullable().optional(),
    limit: external_exports.number().int().min(1).max(PLUGIN_STORE_LIMITS.pageSize).optional()
  }).strict(),
  external_exports.object({ op: external_exports.literal("get"), entryId }).strict(),
  external_exports.object({ op: external_exports.literal("preflight"), entryId }).strict()
]);
var PluginStoreActRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("acquire"), entryId }).strict(),
  external_exports.object({ op: external_exports.literal("cancel"), entryId, discard: external_exports.boolean().optional() }).strict(),
  external_exports.object({ op: external_exports.literal("rollback"), entryId }).strict()
]);
var PLUGIN_STORE_CATALOG_STATES = ["disabled", "fresh", "stale", "offline", "untrusted"];
var PluginStoreStatusViewV1Schema = external_exports.object({
  state: external_exports.enum(PLUGIN_STORE_CATALOG_STATES),
  ageSec: external_exports.number().int().nonnegative().nullable(),
  acquirable: external_exports.boolean()
}).strict();
var PreviewViewSchema = external_exports.object({
  role: external_exports.enum(["cover", "video", "voice"]),
  mime: external_exports.string().max(40),
  sizeBytes: bytes,
  width: external_exports.number().int().positive().nullable(),
  height: external_exports.number().int().positive().nullable(),
  durationMs: external_exports.number().int().positive().nullable(),
  url: external_exports.string().max(400)
}).strict();
var EntryViewShape = {
  entryId,
  packId,
  version,
  name: external_exports.string().max(200),
  summary: external_exports.string().max(500),
  tags: external_exports.array(external_exports.string().max(60)).max(8),
  creator: external_exports.string().max(200),
  downloadBytes: bytes,
  installedBytes: bytes,
  consentLabel: external_exports.string().max(80).nullable()
};
var PluginStoreEntryViewV1Schema = external_exports.object(EntryViewShape).strict();
var PluginStoreEntryDetailViewV1Schema = external_exports.object({ ...EntryViewShape, description: external_exports.string().max(3e3), previews: external_exports.array(PreviewViewSchema).max(3) }).strict();
var PluginStoreListViewV1Schema = external_exports.object({ entries: external_exports.array(PluginStoreEntryViewV1Schema).max(PLUGIN_STORE_LIMITS.pageSize), nextCursor: external_exports.string().max(16).nullable() }).strict();
var NoticeSchema = external_exports.object({ title: external_exports.string().max(200), body: external_exports.string().max(600) }).strict();
var PluginStoreInstalledViewV1Schema = external_exports.object({
  entryId,
  packId,
  version,
  state: external_exports.enum(["ready", "hidden", "disabled", "removed"]),
  withdrawnReason: external_exports.string().max(40).nullable(),
  notice: NoticeSchema.nullable(),
  previousVersion: version.nullable()
}).strict();
var PluginStorePreflightViewV1Schema = external_exports.object({
  downloadBytes: bytes,
  installedBytes: bytes,
  neededBytes: bytes,
  reserveBytes: bytes,
  freeBytes: bytes,
  enough: external_exports.boolean()
}).strict();
var PluginStoreAcquireOutcomeV1Schema = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.enum(["installed", "updated"]), packId, version, name: external_exports.string().max(200) }).strict(),
  external_exports.object({ status: external_exports.literal("cancelled") }).strict()
]);
var PluginStoreRollbackOutcomeV1Schema = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("rolled_back"), packId, version, name: external_exports.string().max(200) }).strict(),
  external_exports.object({ status: external_exports.literal("cancelled") }).strict(),
  external_exports.object({ status: external_exports.literal("no_previous") }).strict()
]);
var PluginStoreAuthorInstalledV1Schema = external_exports.object({ entryId, packId, name: external_exports.string().max(200), version, state: external_exports.enum(["ready", "hidden", "disabled", "removed"]), updateVersion: version.nullable() }).strict();
var PluginStoreAuthorDownloadV1Schema = external_exports.object({ entryId, name: external_exports.string().max(200), version: version.nullable(), stage: external_exports.enum(["confirming", "downloading", "verifying", "installing"]), bytesReceived: bytes, bytesTotal: bytes.nullable() }).strict();
var PluginStoreAuthorLibraryV1Schema = external_exports.object({ protocolVersion: external_exports.literal(1), installed: external_exports.array(PluginStoreAuthorInstalledV1Schema).max(200), downloads: external_exports.array(PluginStoreAuthorDownloadV1Schema).max(50) }).strict();
var PluginStoreAuthorLibraryRequestV1Schema = external_exports.object({ protocolVersion: external_exports.literal(1), op: external_exports.literal("library") }).strict();
var PluginStoreAuthorEventV1Schema = external_exports.discriminatedUnion("type", [
  external_exports.object({ protocolVersion: external_exports.literal(1), type: external_exports.literal("progress"), entryId, stage: external_exports.enum(["confirming", "downloading", "verifying", "installing"]), bytesReceived: bytes, bytesTotal: bytes.nullable() }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(1), type: external_exports.literal("outcome"), entryId, status: external_exports.enum(["installed", "updated", "cancelled", "failed"]) }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(1), type: external_exports.literal("library-changed"), entryId }).strict()
]);
var PluginStoreAuthorSubscriptionRequestV1Schema = external_exports.discriminatedUnion("op", [external_exports.object({ protocolVersion: external_exports.literal(1), op: external_exports.enum(["subscribe", "unsubscribe"]) }).strict()]);
var PluginStoreAuthorSubscriptionResultV1Schema = external_exports.object({ protocolVersion: external_exports.literal(1), subscribed: external_exports.boolean() }).strict();

var MODEL_ACQUIRE_ERROR_CODES = Object.freeze([
  "model_signin_required",
  "model_unavailable",
  "model_invalid_response",
  "model_package_not_found",
  "model_no_published_version",
  "model_no_matching_version",
  "model_not_owned",
  "model_too_large",
  "model_disk_insufficient",
  "model_download_failed",
  "model_hash_mismatch",
  "model_signature_invalid",
  "model_busy",
  "model_cancelled"
]);
var MODEL_ACQUIRE_STAGES = [
  "resolving",
  "confirming",
  "downloading",
  "verifying",
  "installing",
  "complete",
  "failed",
  "cancelled"
];
var PLUGIN_MODELS_CHANNELS = Object.freeze({
  ACT: "plugin-models:act",
  PROGRESS: "plugin-models:progress",
  PROGRESS_SUBSCRIBE: "plugin-models:progress-subscribe",
  PROGRESS_UNSUBSCRIBE: "plugin-models:progress-unsubscribe"
});
var PluginModelsProgressSubscriptionRequestV1Schema = external_exports.object({ protocolVersion: external_exports.literal(1) }).strict();
var PluginModelsProgressSubscriptionResultV1Schema = external_exports.object({ protocolVersion: external_exports.literal(1), ok: external_exports.literal(true), subscribed: external_exports.boolean() }).strict();
var safeCount = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var modelPackStateSchema = external_exports.object({
  state: external_exports.enum(["installed", "missing", "unavailable"]),
  version: external_exports.string().max(32).nullable(),
  signer: external_exports.enum(["teamuq", "dev", "unsigned"]).nullable()
}).strict();
var modelRemoteStateSchema = external_exports.object({
  state: external_exports.enum(["available", "package_not_found", "no_published_version", "no_matching_version", "signed_out", "unavailable", "invalid_response"]),
  version: external_exports.string().max(32).nullable(),
  sizeBytes: safeCount.nullable(),
  sha256: external_exports.string().regex(/^[0-9a-f]{64}$/).nullable(),
  name: external_exports.string().max(200).nullable()
}).strict();
var modelAcquisitionStateSchema = external_exports.object({
  state: external_exports.enum(["idle", "resolving", "confirming", "downloading", "verifying", "installing", "cancelled", "failed"]),
  bytesReceived: safeCount,
  bytesTotal: safeCount.nullable(),
  error: external_exports.enum(MODEL_ACQUIRE_ERROR_CODES).nullable()
}).strict();
var ModelPackViewV1Schema = external_exports.object({
  packId: external_exports.string().min(3).max(96),
  range: external_exports.string().min(1).max(128),
  required: external_exports.boolean(),
  local: modelPackStateSchema,
  remote: modelRemoteStateSchema,
  acquisition: modelAcquisitionStateSchema
}).strict();
var ModelPackListViewV1Schema = external_exports.array(ModelPackViewV1Schema).max(50);
var ModelAcquireProgressV1Schema = external_exports.object({
  packId: external_exports.string().min(3).max(96),
  stage: external_exports.enum(MODEL_ACQUIRE_STAGES),
  bytesReceived: safeCount,
  bytesTotal: safeCount.nullable(),
  error: external_exports.enum(MODEL_ACQUIRE_ERROR_CODES).nullable()
}).strict();
var PluginModelsProgressEventV1Schema = external_exports.object({
  type: external_exports.literal("progress"),
  progress: ModelAcquireProgressV1Schema
}).strict();
var ModelAcquireOutcomeV1Schema = external_exports.object({
  status: external_exports.enum(["installed", "updated"]),
  packId: external_exports.string().min(3).max(96),
  version: external_exports.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/)
}).strict();
var PluginModelsActRequestV1Schema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("acquire"), packId: external_exports.string().min(3).max(96) }).strict(),
  external_exports.object({ op: external_exports.literal("cancel"), packId: external_exports.string().min(3).max(96) }).strict()
]);

var PLUGIN_CORE_CHANNELS = Object.freeze({
  AGENT_AVATAR: "plugin-view:agent-avatar",
  STORAGE: "plugin-view:storage",
  SETTINGS: "plugin-view:settings",
  SECRETS: "plugin-view:secrets",
  ASSET_PACKS: "plugin-view:asset-packs",
  ASSET_PACK_MANAGE: "plugin-view:asset-pack-manage",
  STORE: "plugin-view:store",
  STORE_ACQUIRE: "plugin-view:store-acquire",
  STORE_EVENT: "plugin-view:store-event",
  MODELS_ACT: PLUGIN_MODELS_CHANNELS.ACT,
  MODELS_PROGRESS: PLUGIN_MODELS_CHANNELS.PROGRESS
});
var PLUGIN_CORE_PERMISSIONS = Object.freeze({
  AGENT_AVATAR_READ: "agent:avatar-read",
  STORAGE: "storage:plugin-data",
  ASSETS: "assets:plugin-data",
  SETTINGS: "settings:plugin",
  SECRETS: "secrets:plugin",
  ASSET_PACK: "asset:pack",
  STORE_BROWSE: "store:browse"
});
var PLUGIN_CORE_LIMITS = Object.freeze({
  agentAvatarBytes: 5 * 1024 * 1024,
  pathChars: 240,
  segmentChars: 100,
  chunkBytes: 8 * 1024 * 1024,
  fileBytes: 4 * 1024 * 1024 * 1024,
  listEntries: 1e3,
  settingsKeys: 256,
  settingsBytes: 256 * 1024,
  secretNames: 64,
  secretBytes: 8 * 1024
});
var PLUGIN_CORE_ERROR_CODES = Object.freeze([
  "plugin_permission_denied",
  "plugin_not_active",
  "plugin_request_invalid",
  "agent_avatar_unavailable",
  "storage_path_invalid",
  "storage_path_escapes",
  "storage_not_found",
  "storage_not_a_file",
  "storage_too_large",
  "storage_failed",
  "settings_too_large",
  "settings_failed",
  "secrets_unavailable",
  "secrets_too_large",
  "secrets_corrupt",
  "secrets_failed",
  "asset_pack_not_declared",
  "asset_pack_unavailable",
  "asset_pack_failed",
  "asset_pack_wrong_kind",
  "asset_pack_not_owned",
  "asset_pack_version_mismatch",
  "asset_pack_signer_mismatch",
  "asset_pack_already_installed",
  "asset_pack_rejected",
  "asset_pack_busy",
  ...PLUGIN_STORE_ERROR_CODES
]);
var relativePath2 = external_exports.string().max(PLUGIN_CORE_LIMITS.pathChars);
var settingsKey = external_exports.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
var secretName = external_exports.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
var bytes2 = external_exports.instanceof(Uint8Array).refine((value) => value.byteLength <= PLUGIN_CORE_LIMITS.chunkBytes, { message: "chunk too large" });
var PluginAgentAvatarRequestV1Schema = external_exports.object({ protocolVersion: external_exports.literal(1), agentId: external_exports.string().min(1).max(200) }).strict();
var PluginAgentAvatarResultV1Schema = external_exports.object({ protocolVersion: external_exports.literal(1), image: external_exports.object({ mimeType: external_exports.enum(["image/png", "image/jpeg", "image/webp"]), bytes: external_exports.instanceof(Uint8Array).refine((value) => value.byteLength <= PLUGIN_CORE_LIMITS.agentAvatarBytes) }).strict().nullable() }).strict();
var PluginStorageRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("read"), path: relativePath2, offset: external_exports.number().int().nonnegative().optional(), length: external_exports.number().int().positive().max(PLUGIN_CORE_LIMITS.chunkBytes).optional() }).strict(),
  external_exports.object({ op: external_exports.literal("write"), path: relativePath2, data: bytes2, append: external_exports.boolean().optional() }).strict(),
  external_exports.object({ op: external_exports.literal("list"), path: relativePath2.optional() }).strict(),
  external_exports.object({ op: external_exports.literal("stat"), path: relativePath2 }).strict(),
  external_exports.object({ op: external_exports.literal("remove"), path: relativePath2, recursive: external_exports.boolean().optional() }).strict()
]);
var PluginSettingsRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("get"), key: settingsKey }).strict(),
  external_exports.object({ op: external_exports.literal("set"), key: settingsKey, value: external_exports.unknown() }).strict(),
  external_exports.object({ op: external_exports.literal("remove"), key: settingsKey }).strict(),
  external_exports.object({ op: external_exports.literal("all") }).strict()
]);
var PluginSecretsRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("get"), name: secretName }).strict(),
  external_exports.object({ op: external_exports.literal("set"), name: secretName, value: external_exports.string().max(PLUGIN_CORE_LIMITS.secretBytes) }).strict(),
  external_exports.object({ op: external_exports.literal("remove"), name: secretName }).strict(),
  external_exports.object({ op: external_exports.literal("list") }).strict(),
  external_exports.object({ op: external_exports.literal("available") }).strict()
]);
var PluginAssetPacksRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("list") }).strict(),
  external_exports.object({ op: external_exports.literal("files"), packId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96) }).strict()
]);
var PluginAssetPackManageRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("import") }).strict(),
  external_exports.object({ op: external_exports.literal("installed") }).strict(),
  external_exports.object({ op: external_exports.literal("remove"), packId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96) }).strict()
]);
var PluginAssetPackStatusSchema = external_exports.enum(["ready", "missing", "version_mismatch", "signer_mismatch", "invalid"]);
var PluginAssetPackStateSchema = external_exports.object({
  id: external_exports.string(),
  range: external_exports.string(),
  required: external_exports.boolean(),
  status: PluginAssetPackStatusSchema,
  version: external_exports.string().nullable()
}).strict();
var PluginAssetPackFileSchema = external_exports.object({ path: external_exports.string(), size: external_exports.number().int().nonnegative() }).strict();
var PluginOwnedAssetPackSchema = external_exports.object({
  id: external_exports.string(),
  version: external_exports.string(),
  name: external_exports.string(),
  sizeBytes: external_exports.number().int().nonnegative(),
  fileCount: external_exports.number().int().nonnegative(),
  status: external_exports.enum(["ready", "invalid"])
}).strict();
var PluginOwnedAssetPacksSchema = external_exports.array(PluginOwnedAssetPackSchema).max(64);
var PluginAssetPackImportResultSchema = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("installed"), pack: PluginOwnedAssetPackSchema }).strict(),
  external_exports.object({ status: external_exports.literal("cancelled") }).strict()
]);
var PluginAssetPackRemoveResultSchema = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("removed"), packId: external_exports.string() }).strict(),
  external_exports.object({ status: external_exports.literal("cancelled") }).strict()
]);
var PluginCoreEnvelopeSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ ok: external_exports.literal(true), value: external_exports.unknown() }).strict(),
  external_exports.object({ ok: external_exports.literal(false), error: external_exports.enum(PLUGIN_CORE_ERROR_CODES) }).strict()
]);
var PluginModelsEnvelopeV1Schema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: external_exports.literal(1), ok: external_exports.literal(true), value: external_exports.unknown() }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(1), ok: external_exports.literal(false), error: external_exports.enum(MODEL_ACQUIRE_ERROR_CODES) }).strict()
]);
var PluginModelsAcquireResultV1Schema = external_exports.object({ protocolVersion: external_exports.literal(1), ok: external_exports.literal(true), value: ModelAcquireOutcomeV1Schema }).strict();
var PluginModelsCancelResultV1Schema = external_exports.object({ protocolVersion: external_exports.literal(1), ok: external_exports.literal(true), value: external_exports.object({ cancelled: external_exports.literal(true) }).strict() }).strict();

var PluginSurfaceInstallRecordV1Schema = external_exports.object({
  id: external_exports.string().min(3).max(96),
  version: external_exports.string().min(5).max(32),
  name: external_exports.string().min(1).max(96),
  publisher: external_exports.string().min(2).max(48),
  signer: external_exports.discriminatedUnion("kind", [external_exports.object({ kind: external_exports.literal("teamuq"), keyId: external_exports.string().min(3).max(64) }).strict(), external_exports.object({ kind: external_exports.literal("dev"), keyId: external_exports.string().min(3).max(64), label: external_exports.string().min(1).max(48) }).strict(), external_exports.object({ kind: external_exports.literal("unsigned") }).strict()]),
  manifestSha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
  integritySha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
  grants: external_exports.array(external_exports.string().min(3).max(64)).max(64),
  revoked: external_exports.array(external_exports.string().min(3).max(64)).max(64),
  enabled: external_exports.boolean(),
  installedAt: external_exports.string().min(1).max(40),
  dataUninstall: external_exports.enum(["keep", "delete", "ask"]),
  assetPacks: external_exports.array(external_exports.object({ id: external_exports.string().min(3).max(96), range: external_exports.string().max(32), required: external_exports.boolean() }).strict()).max(16),
  assetPackPrefixes: external_exports.array(external_exports.string().min(3).max(90)).max(4),
  trustTier: external_exports.enum(["sandboxed", "full-trust"]),
  backend: external_exports.object({ resources: external_exports.object({ memoryMB: external_exports.number().int().positive(), cpuThreads: external_exports.number().int().positive(), maxSessions: external_exports.number().int().positive(), idleUnloadSec: external_exports.number().int().nonnegative(), bootTimeoutSec: external_exports.number().int().positive() }).strict(), allowAddons: external_exports.boolean(), nativeFiles: external_exports.array(external_exports.string().max(200)).max(64) }).strict().nullable()
}).strict();
var PLUGIN_SURFACE_CHANNELS = Object.freeze({
  SYNC: "plugin-runtime:surface-sync",
  PRESENTATION_SET: "plugin-runtime:presentation-set",
  CLOSE: "plugin-runtime:surface-close",
  RELOAD: "plugin-runtime:surface-reload",
  MASK: "plugin-runtime:surface-mask",
  FOCUS: "plugin-runtime:surface-focus",
  STATE: "plugin-runtime:surface-state"
});
var PLUGIN_VIEW_CHANNELS = Object.freeze({
  PRESENTATION_GET: "plugin-view:presentation-get",
  PRESENTATION_REQUEST: "plugin-view:presentation-request",
  PRESENTATION_CHANGED: "plugin-view:presentation-changed",
  VISIBILITY: "plugin-view:visibility",
  MEDIA_REPORT: "plugin-view:media-report",
  MEDIA_COMMAND: "plugin-view:media-command"
});
var PRESENTATION_ERROR_CODES = Object.freeze([
  "presentation_not_declared",
  "presentation_not_granted",
  "presentation_requires_focus",
  "presentation_rate_limited",
  "presentation_requires_fullpage",
  "presentation_not_visible",
  "presentation_view_unavailable"
]);
var protocolVersion3 = external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION);
var pluginId5 = external_exports.string().min(3).max(96).regex(IDENTIFIER_PATTERN);
var viewId = external_exports.string().min(1).max(32).regex(IDENTIFIER_PATTERN);
var coordinate = external_exports.number().finite().min(-1e5).max(1e5);
var extent = external_exports.number().finite().min(0).max(1e5);
var PluginPresentationModeSchema = external_exports.enum(["tab", "fullpage"]);
var PluginRequestedModeSchema = external_exports.enum(["tab", "window", "fullpage", "overlay"]);
var PluginSurfaceRectV1Schema = external_exports.object({ x: coordinate, y: coordinate, width: extent, height: extent }).strict();
var PluginSurfaceSyncRequestV1Schema = external_exports.object({
  protocolVersion: protocolVersion3,
  pluginId: pluginId5,
  viewId,
  active: external_exports.boolean(),
  rect: PluginSurfaceRectV1Schema.nullable(),
  coreOverlay: external_exports.boolean(),
  keyboardExit: external_exports.boolean().optional()
}).strict();
var PluginPresentationSetRequestV1Schema = external_exports.object({
  protocolVersion: protocolVersion3,
  pluginId: pluginId5,
  viewId,
  mode: PluginPresentationModeSchema,
  fullscreen: external_exports.boolean()
}).strict();
var PluginSurfaceMaskRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion3, masked: external_exports.boolean() }).strict();
var PluginSurfaceTargetRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion3, pluginId: pluginId5, viewId }).strict();
var PluginCaptureStateSchema = external_exports.object({ microphone: external_exports.boolean(), camera: external_exports.boolean() }).strict();
var PluginSurfaceStateV1Schema = external_exports.object({
  pluginId: pluginId5,
  viewId,
  mode: PluginPresentationModeSchema,
  fullscreen: external_exports.boolean(),
  status: external_exports.enum(["idle", "loading", "ready", "covered", "hidden", "crashed", "closed"]),
  errorCode: external_exports.string().min(1).max(96).nullable(),
  capture: PluginCaptureStateSchema.default({ microphone: false, camera: false })
}).strict();
var PluginSurfaceStateEventV1Schema = external_exports.object({ protocolVersion: protocolVersion3, state: PluginSurfaceStateV1Schema }).strict();
var errorEnvelope = external_exports.object({ code: external_exports.string().min(1).max(96).regex(/^[a-z0-9_]+$/), message: external_exports.string().min(1).max(512) }).strict();
var PluginSurfaceResultEnvelopeV1Schema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion3, ok: external_exports.literal(true), value: PluginSurfaceStateV1Schema }).strict(),
  external_exports.object({ protocolVersion: protocolVersion3, ok: external_exports.literal(false), error: errorEnvelope }).strict()
]);
var PluginSurfaceMaskValueV1Schema = external_exports.object({ masked: external_exports.boolean(), hiddenViews: external_exports.number().int().min(0).max(1024) }).strict();
var PluginSurfaceMaskEnvelopeV1Schema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion3, ok: external_exports.literal(true), value: PluginSurfaceMaskValueV1Schema }).strict(),
  external_exports.object({ protocolVersion: protocolVersion3, ok: external_exports.literal(false), error: errorEnvelope }).strict()
]);
var PluginViewPresentationStateSchema = external_exports.object({
  mode: PluginPresentationModeSchema,
  fullscreen: external_exports.boolean(),
  visible: external_exports.boolean()
}).strict();
var PluginViewPresentationRequestSchema = external_exports.object({
  mode: PluginRequestedModeSchema,
  fullscreen: external_exports.boolean().optional()
}).strict();
var PluginViewPresentationResultSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ ok: external_exports.literal(true), state: PluginViewPresentationStateSchema }).strict(),
  external_exports.object({ ok: external_exports.literal(false), error: external_exports.enum(PRESENTATION_ERROR_CODES) }).strict()
]);
var PluginViewPresentationChangeSchema = external_exports.object({
  phase: external_exports.enum(["before", "after"]),
  from: PluginPresentationModeSchema,
  to: PluginPresentationModeSchema,
  fullscreen: external_exports.boolean(),
  visible: external_exports.boolean(),
  reason: external_exports.enum(["user", "plugin", "core", "escape", "window"])
}).strict();
var PluginViewVisibilityReportSchema = external_exports.object({ state: external_exports.enum(["visible", "hidden"]) }).strict();
var counter = external_exports.number().int().min(0).max(1e6);
var PluginViewMediaReportSchema = external_exports.object({ requestId: counter.nullable(), live: counter, calls: counter, successes: counter }).strict();
var PluginViewMediaCommandSchema = external_exports.object({ requestId: counter, action: external_exports.enum(["stop", "resume"]) }).strict();

var PLUGIN_ICON_MAX_BYTES = 64 * 1024;
var DATA_URL_PREFIX = "data:image/png;base64,";
var PLUGIN_ICON_DATA_URL_MAX_CHARS = Math.ceil(PLUGIN_ICON_MAX_BYTES / 3) * 4 + DATA_URL_PREFIX.length;
var PLUGIN_ICON_DATA_URL_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

var PLUGIN_INSTALL_CHANNELS = Object.freeze({
  LIST: "plugin-install:list",
  BEGIN: "plugin-install:begin",
  UNINSTALL: "plugin-install:uninstall",
  UNINSTALL_PREVIEW: "plugin-install:uninstall-preview",
  IMPORT_DEV_KEY: "plugin-install:import-dev-key",
  REMOVE_DEV_KEY: "plugin-install:remove-dev-key",
  PICK_DEV_KEY: "plugin-install:pick-dev-key",
  DECIDE_DEV_KEY: "plugin-install:decide-dev-key",
  REMOVE_ASSET_PACK: "plugin-install:remove-asset-pack",
  SET_PERMISSION: "plugin-install:set-permission",
  SET_PROVIDER: "plugin-install:set-provider",
  BUNDLED_RESTORE: "plugin-install:bundled-restore",
  BEGIN_ASSET_PACK: "plugin-install:begin-asset-pack",
  NATIVE_CONFIRM: "plugin-install:native-confirm",
  SETTINGS_GET: "plugin-install:settings-get",
  SETTINGS_SET: "plugin-install:settings-set",
  SETTINGS_RESET: "plugin-install:settings-reset",
  STORE_CATALOG: "plugin-install:store-catalog",
  STORE_ACQUIRE: "plugin-install:store-acquire",
  STORE_CANCEL: "plugin-install:store-cancel",
  STORE_DISCARD: "plugin-install:store-discard",
  STORE_DOWNLOADS: "plugin-install:store-downloads",
  STORE_PROGRESS: "plugin-install:store-progress",
  STORE_OUTCOME: "plugin-install:store-outcome",
  STORE_CONFIRM: "plugin-install:store-confirm",
  STORE_CONFIRM_REPLY: "plugin-install:store-confirm-reply",
  STORE_LIBRARY: "plugin-install:store-library",
  STORE_NOTICES_CHANGED: "plugin-install:store-notices-changed"
});
var protocolVersion4 = external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION);
var installId = external_exports.string().regex(/^[0-9a-f]{32}$/);
var keyId = external_exports.string().regex(/^dev-[0-9a-f]{16}$/);
var PluginInstallListRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4 }).strict();
var PluginInstallBeginRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4 }).strict();
var uninstallOptionFields = { removeOwnedPacks: external_exports.boolean().default(false), revokeDevKey: external_exports.boolean().default(false) };
var PluginUninstallOptionsV1Schema = external_exports.object(uninstallOptionFields).strict();
var PluginUninstallRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4, pluginId: external_exports.string().regex(IDENTIFIER_PATTERN), deleteData: external_exports.boolean(), ...uninstallOptionFields }).strict();
var PluginUninstallPreviewRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4, pluginId: external_exports.string().regex(IDENTIFIER_PATTERN) }).strict();
var PluginDevKeyImportRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4, publicKey: external_exports.string().min(1).max(4096), label: external_exports.string().min(1).max(48) }).strict();
var settingValue = external_exports.union([external_exports.boolean(), external_exports.number().finite(), external_exports.string().max(1024)]);
var PluginSettingsGetRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4, pluginId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96) }).strict();
var PluginSettingsSetRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4, pluginId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96), values: external_exports.record(external_exports.string().regex(/^[A-Za-z0-9._-]{1,64}$/), settingValue).refine((values) => Object.keys(values).length <= 16) }).strict();
var SETTINGS_FORM_ISSUES = ["type", "range", "step", "option", "length", "chars", "unknown_key", "missing"];
var PluginSettingsFormResultV1Schema = external_exports.object({
  pluginId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96),
  saved: external_exports.boolean(),
  values: external_exports.record(external_exports.string(), settingValue),
  errors: external_exports.record(external_exports.string().max(64), external_exports.enum(SETTINGS_FORM_ISSUES))
}).strict();
var PluginAssetPackBeginRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4, pluginId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96) }).strict();
var PluginAssetPackRemoveRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4, packId: external_exports.string().regex(IDENTIFIER_PATTERN) }).strict();
var PluginPermissionSetRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4, pluginId: external_exports.string().regex(IDENTIFIER_PATTERN), permission: external_exports.string().min(3).max(64), revoked: external_exports.boolean() }).strict();
var PluginDevKeyRemoveRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4, keyId }).strict();
var PluginDevKeyPickRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4 }).strict();
var DEV_KEY_TRUST_DECISIONS = ["trust", "decline"];
var PluginDevKeyDecideRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4, trustId: installId, decision: external_exports.enum(DEV_KEY_TRUST_DECISIONS), label: external_exports.string().min(1).max(48).optional() }).strict();
var pluginIdField = external_exports.string().regex(IDENTIFIER_PATTERN).max(96);
var PluginNativeConfirmRequestV1Schema = external_exports.object({
  protocolVersion: protocolVersion4,
  title: external_exports.string().min(1).max(80),
  message: external_exports.string().min(1).max(400),
  detail: external_exports.string().max(800).optional(),
  confirmLabel: external_exports.string().min(1).max(24),
  cancelLabel: external_exports.string().min(1).max(24)
}).strict();
var BUNDLED_LISTED_STATES = ["removed", "verification_failed"];
var PluginBundledRestoreRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4, pluginId: pluginIdField }).strict();
var UNINSTALL_PREVIEW_MAX_PACKS = 16;
var PluginUninstallPreviewV1Schema = external_exports.object({
  pluginId: pluginIdField,
  builtIn: external_exports.boolean(),
  canDeleteData: external_exports.boolean(),
  dataDefault: external_exports.enum(["keep", "delete", "ask"]),
  dataSizeBytes: external_exports.number().int().nonnegative(),
  dataSizeComplete: external_exports.boolean(),
  ownedPacks: external_exports.array(external_exports.object({ id: external_exports.string().min(3).max(96), name: external_exports.string().min(1).max(96), sizeBytes: external_exports.number().int().nonnegative() }).strict()).max(UNINSTALL_PREVIEW_MAX_PACKS),
  ownedPacksMore: external_exports.number().int().nonnegative(),
  devKeyToRevoke: external_exports.object({ keyId: external_exports.string().min(3).max(64), label: external_exports.string().max(48) }).strict().nullable()
}).strict();
var PluginProviderSetRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4, capability: external_exports.string().regex(CAPABILITY_PATTERN).max(96), providerId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96).nullable() }).strict();
var PLUGIN_RISK_NOTICES = ["full_trust", "native_code", "network_unrestricted", "dev_key_local_only", "file_sandbox_bypassable", "ai_agent_unrestricted", "process_helper"];
var RiskNoticeSchema = external_exports.enum(PLUGIN_RISK_NOTICES);
var BackendViewSchema = external_exports.object({
  resources: external_exports.object({
    memoryMB: external_exports.number().int().positive(),
    cpuThreads: external_exports.number().int().positive(),
    maxSessions: external_exports.number().int().positive(),
    idleUnloadSec: external_exports.number().int().nonnegative(),
    bootTimeoutSec: external_exports.number().int().positive()
  }).strict(),
  allowAddons: external_exports.boolean(),
  nativeFiles: external_exports.array(external_exports.string().max(200)).max(64)
}).strict();
var PluginSignerViewV1Schema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("teamuq"), keyId: external_exports.string().min(3).max(64), label: external_exports.null() }).strict(),
  external_exports.object({ kind: external_exports.literal("dev"), keyId: external_exports.string().min(3).max(64), label: external_exports.string().max(48).nullable() }).strict(),
  external_exports.object({ kind: external_exports.literal("unsigned"), keyId: external_exports.null(), label: external_exports.null() }).strict()
]);
var AssetPackRefViewSchema = external_exports.object({
  id: external_exports.string().max(96),
  range: external_exports.string().max(32),
  required: external_exports.boolean(),
  status: PluginAssetPackStatusSchema,
  version: external_exports.string().max(32).nullable(),
  name: external_exports.string().max(96).nullable().default(null),
  sizeBytes: external_exports.number().int().nonnegative().nullable().default(null)
}).strict();
var CapabilityConsentViewSchema = external_exports.object({
  capability: external_exports.string().regex(CAPABILITY_PATTERN).max(96),
  providerId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96),
  providerVersion: external_exports.string().max(32),
  grantedAt: external_exports.string().max(40),
  providerDataClass: external_exports.enum(["local", "cloud"]).optional(),
  highRiskGroups: external_exports.array(GroupIdSchema).max(8).default([])
}).strict();
var InstalledPluginViewV1Schema = external_exports.object({
  id: external_exports.string().regex(IDENTIFIER_PATTERN),
  name: external_exports.string().max(96),
  version: external_exports.string().max(32),
  publisher: external_exports.string().max(48),
  signer: PluginSignerViewV1Schema,
  permissions: external_exports.array(external_exports.string().max(64)).max(64),
  revokedPermissions: external_exports.array(external_exports.string().max(64)).max(64).default([]),
  dataUninstall: external_exports.enum(["keep", "delete", "ask"]),
  installedAt: external_exports.string().max(40),
  blockedCode: external_exports.string().max(96).nullable(),
  hasView: external_exports.boolean().default(false),
  description: external_exports.string().max(512).nullable().default(null),
  provides: external_exports.array(external_exports.string().regex(CAPABILITY_PATTERN).max(96)).max(16).default([]),
  networkOrigins: external_exports.array(external_exports.string().max(200)).max(32).default([]),
  iconDataUrl: external_exports.string().max(PLUGIN_ICON_DATA_URL_MAX_CHARS).regex(PLUGIN_ICON_DATA_URL_PATTERN).nullable().default(null),
  assetPacks: external_exports.array(AssetPackRefViewSchema).max(16).default([]),
  trustTier: external_exports.enum(["sandboxed", "full-trust"]).default("sandboxed"),
  backend: BackendViewSchema.nullable().default(null),
  riskNotices: external_exports.array(RiskNoticeSchema).max(8).default([]),
  capabilityConsents: external_exports.array(CapabilityConsentViewSchema).max(64).default([]),
  aiUsage: AiChatUsageSchema.nullable().default(null),
  settingsSchema: PluginSettingsSchemaSchema.nullable().default(null),
  hasSettingsView: external_exports.boolean().default(false)
}).strict();
var InstalledAssetPackViewV1Schema = external_exports.object({
  id: external_exports.string().regex(IDENTIFIER_PATTERN),
  version: external_exports.string().max(32),
  name: external_exports.string().max(96),
  publisher: external_exports.string().max(48),
  signer: PluginSignerViewV1Schema,
  installedAt: external_exports.string().max(40),
  sizeBytes: external_exports.number().int().nonnegative(),
  fileCount: external_exports.number().int().nonnegative(),
  blockedCode: external_exports.string().max(96).nullable(),
  dependents: external_exports.array(external_exports.string().regex(IDENTIFIER_PATTERN)).max(256)
}).strict();
var DevKeyViewV1Schema = external_exports.object({
  keyId,
  fingerprint: external_exports.string().regex(/^[0-9a-f]{64}$/),
  label: external_exports.string().max(48),
  importedAt: external_exports.string().max(40),
  trustedHere: external_exports.boolean()
}).strict();
var DevKeyTrustReviewV1Schema = external_exports.object({
  trustId: installId,
  keyId,
  fingerprint: external_exports.string().regex(/^[0-9a-f]{64}$/),
  fileName: external_exports.string().max(200),
  defaultLabel: external_exports.string().min(1).max(48),
  alreadyTrusted: external_exports.boolean()
}).strict();
var BundledPluginEntryViewV1Schema = external_exports.object({
  id: pluginIdField,
  name: external_exports.string().max(96),
  state: external_exports.enum(BUNDLED_LISTED_STATES),
  offeredVersion: external_exports.string().regex(VERSION_PATTERN),
  installedVersion: external_exports.string().regex(VERSION_PATTERN).nullable(),
  failureCode: external_exports.string().max(96).nullable()
}).strict();
var PluginInstallListV1Schema = external_exports.object({
  protocolVersion: protocolVersion4,
  plugins: external_exports.array(InstalledPluginViewV1Schema),
  developerPanelEnabled: external_exports.boolean().default(false),
  developerViews: external_exports.array(PluginSurfaceStateV1Schema).max(1024).default([]),
  assetPacks: external_exports.array(InstalledAssetPackViewV1Schema).default([]),
  bundledPlugins: external_exports.array(BundledPluginEntryViewV1Schema).max(16).default([]),
  coreConsents: external_exports.array(CapabilityConsentViewSchema).max(64).default([]),
  devKeys: external_exports.array(DevKeyViewV1Schema)
}).strict();
var ReviewPermissionSchema = external_exports.object({ permission: external_exports.string().max(64), description: external_exports.string().max(2048) }).strict();
var PluginInstalledSummaryV1Schema = external_exports.object({
  kind: external_exports.enum(["plugin", "asset-pack"]).default("plugin"),
  sizeBytes: external_exports.number().int().nonnegative().default(0),
  assetPacks: external_exports.array(external_exports.object({ id: external_exports.string().max(96), range: external_exports.string().max(32), required: external_exports.boolean(), installed: external_exports.boolean() }).strict()).max(16).default([]),
  fileName: external_exports.string().max(200),
  id: external_exports.string().regex(IDENTIFIER_PATTERN),
  name: external_exports.string().max(96),
  version: external_exports.string().max(32),
  publisher: external_exports.string().max(48),
  description: external_exports.string().max(512).nullable(),
  signer: PluginSignerViewV1Schema,
  permissions: external_exports.array(ReviewPermissionSchema).max(64),
  updateFrom: external_exports.object({ id: external_exports.string().regex(IDENTIFIER_PATTERN), version: external_exports.string().max(32) }).strict().nullable().default(null),
  addedPermissions: external_exports.array(ReviewPermissionSchema).max(64).default([]),
  removedPermissions: external_exports.array(ReviewPermissionSchema).max(64).default([]),
  networkOrigins: external_exports.array(external_exports.string().max(200)).max(32),
  dataUninstall: external_exports.enum(["keep", "delete", "ask"]),
  dependencies: external_exports.array(external_exports.object({ capability: external_exports.string().max(96), provided: external_exports.boolean(), required: external_exports.boolean().default(false), providerName: external_exports.string().max(96).nullable().default(null), allowed: external_exports.boolean().default(true) }).strict()).max(64),
  trustTier: external_exports.enum(["sandboxed", "full-trust"]).default("sandboxed"),
  backend: BackendViewSchema.nullable().default(null),
  riskNotices: external_exports.array(RiskNoticeSchema).max(8).default([])
}).strict();
var PluginAssetPackRedirectV1Schema = external_exports.object({
  status: external_exports.literal("asset_pack_redirect"),
  packId: external_exports.string().regex(IDENTIFIER_PATTERN).max(96),
  packName: external_exports.string().max(96),
  owners: external_exports.array(external_exports.object({ id: external_exports.string().regex(IDENTIFIER_PATTERN).max(96), name: external_exports.string().max(96), hasView: external_exports.boolean() }).strict()).max(16)
}).strict();
var PluginInstallBeginResultV1Schema = external_exports.discriminatedUnion("status", [
  PluginAssetPackRedirectV1Schema,
  external_exports.object({ status: external_exports.literal("cancelled") }).strict(),
  external_exports.object({ status: external_exports.literal("installed"), installed: PluginInstalledSummaryV1Schema, list: PluginInstallListV1Schema }).strict()
]);
var PluginDevKeyPickResultV1Schema = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("cancelled") }).strict(),
  external_exports.object({ status: external_exports.literal("review"), review: DevKeyTrustReviewV1Schema }).strict()
]);
var PluginDevKeyDecideResultV1Schema = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("declined") }).strict(),
  external_exports.object({ status: external_exports.literal("trusted"), keyId }).strict()
]);
var PluginBundledRestoreResultV1Schema = external_exports.object({ pluginId: pluginIdField, status: external_exports.literal("consented") }).strict();
var PluginStoreCatalogRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4, refresh: external_exports.boolean() }).strict();
var STORE_CATALOG_STATES = ["disabled", "fresh", "stale", "offline", "untrusted"];
var STORE_CATALOG_SOURCES = ["production", "dev-local"];
var STORE_CATALOG_VIEW_MAX_ENTRIES = 50;
var StoreCatalogEntryViewSchema = external_exports.object({
  entryId: external_exports.string().max(64),
  kind: external_exports.enum(["asset-pack", "plugin"]),
  id: external_exports.string().max(96),
  version: external_exports.string().max(32),
  name: external_exports.string().max(200),
  summary: external_exports.string().max(500),
  tags: external_exports.array(external_exports.string().max(60)).max(8),
  creator: external_exports.string().max(200),
  sizeBytes: external_exports.number().int().nonnegative()
}).strict();
var PluginStoreCatalogViewV1Schema = external_exports.object({
  state: external_exports.enum(STORE_CATALOG_STATES),
  source: external_exports.enum(STORE_CATALOG_SOURCES).nullable(),
  sequence: external_exports.number().int().nonnegative().nullable(),
  issuedAt: external_exports.string().max(40).nullable(),
  expiresAt: external_exports.string().max(40).nullable(),
  expired: external_exports.boolean(),
  acquirable: external_exports.boolean(),
  ageSec: external_exports.number().int().nonnegative().nullable(),
  entryCount: external_exports.number().int().nonnegative(),
  skipped: external_exports.number().int().nonnegative(),
  lastError: external_exports.string().max(96).nullable(),
  entries: external_exports.array(StoreCatalogEntryViewSchema).max(STORE_CATALOG_VIEW_MAX_ENTRIES)
}).strict();
var storeEntryId = external_exports.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/);
var storeErrorCode = external_exports.string().regex(/^store_[a-z_]{3,40}$/);
var STORE_PROGRESS_STAGES = ["downloading", "verifying", "installing"];
var PluginStoreEntryRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4, entryId: storeEntryId }).strict();
var PluginStoreDownloadsRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4 }).strict();
var StoreRetrySchema = external_exports.object({ attempt: external_exports.number().int().min(1).max(10), max: external_exports.number().int().min(1).max(10) }).strict();
var byteField = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var PluginStoreProgressEventV1Schema = external_exports.object({
  entryId: storeEntryId,
  name: external_exports.string().max(200),
  ownerId: pluginIdField.nullable(),
  stage: external_exports.enum(STORE_PROGRESS_STAGES),
  bytesReceived: byteField,
  bytesTotal: byteField.nullable(),
  retry: StoreRetrySchema.nullable()
}).strict();
var STORE_OUTCOME_STATUSES = ["installed", "updated", "cancelled", "failed"];
var PluginStoreOutcomeEventV1Schema = external_exports.object({
  entryId: storeEntryId,
  name: external_exports.string().max(200),
  ownerId: pluginIdField.nullable(),
  status: external_exports.enum(STORE_OUTCOME_STATUSES)
}).strict();
var STORE_CONFIRM_OUTCOMES = ["shown", "agreed", "declined", "mask_failed"];
var confirmRequestId = external_exports.string().regex(/^[A-Za-z0-9-]{8,64}$/);
var STORE_COVER_DATA_URL_MAX = 72e4;
var storeCoverDataUrl = external_exports.string().max(STORE_COVER_DATA_URL_MAX).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/);
var PluginStoreConfirmPromptV1Schema = external_exports.object({
  name: external_exports.string().min(1).max(200),
  version: external_exports.string().max(32),
  previousVersion: external_exports.string().max(32).nullable(),
  summary: external_exports.string().max(240),
  ownerName: external_exports.string().max(200).nullable(),
  requestedBy: external_exports.enum(["plugin", "core"]),
  realPerson: external_exports.boolean(),
  reconfirm: external_exports.boolean(),
  downloadBytes: byteField,
  installedBytes: byteField,
  neededBytes: byteField,
  freeBytes: byteField,
  packId: external_exports.string().max(96),
  signerKeyId: external_exports.string().max(64),
  sha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
  coverDataUrl: storeCoverDataUrl.nullable().optional()
}).strict();
var STORE_MB = 1024 * 1024;
var STORE_GB = 1024 * STORE_MB;
var PluginStoreRollbackPromptV1Schema = external_exports.object({
  name: external_exports.string().min(1).max(200),
  from: external_exports.string().max(32),
  to: external_exports.string().max(32),
  freedBytes: byteField,
  packId: external_exports.string().max(96)
}).strict();
var PluginStoreConfirmRequestV1Schema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("ask"), requestId: confirmRequestId, prompt: PluginStoreConfirmPromptV1Schema }).strict(),
  external_exports.object({ kind: external_exports.literal("ask-rollback"), requestId: confirmRequestId, prompt: PluginStoreRollbackPromptV1Schema }).strict(),
  external_exports.object({ kind: external_exports.literal("cancel"), requestId: confirmRequestId }).strict()
]);
var PluginStoreConfirmReplyRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion4, requestId: confirmRequestId, outcome: external_exports.enum(STORE_CONFIRM_OUTCOMES) }).strict();
var PluginStoreAcquireResultV1Schema = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.enum(["installed", "updated"]), packId: external_exports.string().max(96), version: external_exports.string().max(32), name: external_exports.string().max(200) }).strict(),
  external_exports.object({ status: external_exports.literal("cancelled") }).strict()
]);
var PluginStoreDownloadsViewV1Schema = external_exports.object({
  active: PluginStoreProgressEventV1Schema.extend({ stage: external_exports.enum(["confirming", ...STORE_PROGRESS_STAGES]) }).strict().nullable(),
  pending: external_exports.array(external_exports.object({ entryId: storeEntryId, name: external_exports.string().max(200), version: external_exports.string().max(32), ownerId: pluginIdField.nullable(), bytesReceived: byteField, bytesTotal: byteField, stale: external_exports.boolean() }).strict()).max(50),
  recent: external_exports.object({ entryId: storeEntryId, name: external_exports.string().max(200), ownerId: pluginIdField.nullable(), code: storeErrorCode }).strict().nullable(),
  installed: external_exports.array(external_exports.object({ entryId: storeEntryId, version: external_exports.string().max(32) }).strict()).max(1e3)
}).strict();
var libraryNotice = external_exports.object({ title: external_exports.string().max(200), body: external_exports.string().max(600) }).strict();
var noticeId = external_exports.string().regex(/^[0-9a-f]{24}-(?:disable|remove)$/);
var PluginStoreLibraryRequestV1Schema = external_exports.discriminatedUnion("op", [
  external_exports.object({ protocolVersion: protocolVersion4, op: external_exports.literal("characters"), ownerId: pluginIdField }).strict(),
  external_exports.object({ protocolVersion: protocolVersion4, op: external_exports.literal("rollback"), ownerId: pluginIdField, entryId: storeEntryId, expectedVersion: external_exports.string().max(32) }).strict(),
  external_exports.object({ protocolVersion: protocolVersion4, op: external_exports.literal("notices") }).strict(),
  external_exports.object({ protocolVersion: protocolVersion4, op: external_exports.literal("seen"), noticeId }).strict(),
  external_exports.object({ protocolVersion: protocolVersion4, op: external_exports.literal("dismiss"), entryId: storeEntryId }).strict()
]);
var PluginStoreCharacterViewV1Schema = external_exports.object({
  entryId: storeEntryId,
  packId: external_exports.string().max(96),
  name: external_exports.string().max(200),
  version: external_exports.string().max(32),
  sizeBytes: byteField.nullable(),
  addedAt: external_exports.string().max(40).nullable(),
  state: external_exports.enum(["ready", "hidden", "disabled", "removed"]),
  withdrawnReason: external_exports.string().max(40).nullable(),
  notice: libraryNotice.nullable(),
  previousVersion: external_exports.string().max(32).nullable(),
  update: external_exports.object({ version: external_exports.string().max(32), downloadBytes: byteField.nullable() }).strict().nullable(),
  daysLeft: external_exports.number().int().min(0).max(30).nullable()
}).strict();
var PluginStoreNoticeViewV1Schema = external_exports.object({
  noticeId,
  ownerId: pluginIdField.nullable(),
  entryId: storeEntryId.nullable(),
  severity: external_exports.enum(["disable", "remove"]),
  name: external_exports.string().max(200),
  title: external_exports.string().max(200),
  body: external_exports.string().max(600)
}).strict();
var PluginStoreLibraryResultV1Schema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("characters"), items: external_exports.array(PluginStoreCharacterViewV1Schema).max(200) }).strict(),
  external_exports.object({ kind: external_exports.literal("rollback"), outcome: external_exports.discriminatedUnion("status", [
    external_exports.object({ status: external_exports.literal("rolled_back"), packId: external_exports.string().max(96), version: external_exports.string().max(32), name: external_exports.string().max(200) }).strict(),
    external_exports.object({ status: external_exports.literal("cancelled") }).strict(),
    external_exports.object({ status: external_exports.literal("no_previous") }).strict()
  ]) }).strict(),
  external_exports.object({ kind: external_exports.literal("notices"), items: external_exports.array(PluginStoreNoticeViewV1Schema).max(50) }).strict(),
  external_exports.object({ kind: external_exports.literal("done") }).strict()
]);
var envelope = (value) => external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion4, ok: external_exports.literal(true), value }).strict(),
  external_exports.object({ protocolVersion: protocolVersion4, ok: external_exports.literal(false), error: PluginRuntimeErrorV1Schema }).strict()
]);
var PluginInstallListEnvelopeV1Schema = envelope(PluginInstallListV1Schema);
var PluginInstallBeginEnvelopeV1Schema = envelope(PluginInstallBeginResultV1Schema);
var PluginDevKeyPickEnvelopeV1Schema = envelope(PluginDevKeyPickResultV1Schema);
var PluginDevKeyDecideEnvelopeV1Schema = envelope(PluginDevKeyDecideResultV1Schema);
var PluginBundledRestoreEnvelopeV1Schema = envelope(PluginBundledRestoreResultV1Schema);
var PluginNativeConfirmEnvelopeV1Schema = envelope(external_exports.object({ confirmed: external_exports.boolean() }).strict());
var PluginSettingsFormEnvelopeV1Schema = envelope(PluginSettingsFormResultV1Schema);
var PluginStoreCatalogEnvelopeV1Schema = envelope(PluginStoreCatalogViewV1Schema);
var PluginStoreAcquireEnvelopeV1Schema = envelope(PluginStoreAcquireResultV1Schema);
var PluginStoreDownloadsEnvelopeV1Schema = envelope(PluginStoreDownloadsViewV1Schema);
var PluginStoreLibraryEnvelopeV1Schema = envelope(PluginStoreLibraryResultV1Schema);
var PluginUninstallPreviewEnvelopeV1Schema = envelope(PluginUninstallPreviewV1Schema);
var PluginStoreDoneEnvelopeV1Schema = envelope(external_exports.object({ done: external_exports.literal(true) }).strict());

var EXT_CONTROL_PROTOCOL_VERSION = 1;
var EXT_CONTROL_KINDS = Object.freeze(["ext-endpoint", "ext-link-up", "ext-link-down", "ext-busy", "ext-session-open", "ext-session-opened", "ext-session-close", "ext-link-listener-close"]);
var EXT_LINK_MODES = Object.freeze(["session", "call"]);
var EXT_TICKET_HASH_PATTERN = /^[0-9a-f]{64}$/;
var EXT_LINK_PATH_PATTERN = /^\/l\/[0-9a-f]{32,64}$/;
var EXT_LINK_SECRET_PATTERN = /^[0-9a-f]{32,128}$/;
var protocolVersion5 = external_exports.literal(EXT_CONTROL_PROTOCOL_VERSION);
var linkId = Hex32IdSchema;
var closeReason2 = external_exports.enum(LINK_CLOSE_REASONS);
var ExtEndpointSchema = external_exports.object({
  protocolVersion: protocolVersion5,
  kind: external_exports.literal("ext-endpoint"),
  port: external_exports.number().int().min(1).max(65535).nullable()
}).strict();
var ExtLinkUpSchema = external_exports.object({
  protocolVersion: protocolVersion5,
  kind: external_exports.literal("ext-link-up"),
  linkId,
  group: GroupIdSchema,
  groupVersion: GroupVersionSchema,
  mode: external_exports.enum(EXT_LINK_MODES)
}).strict();
var ExtLinkDownSchema = external_exports.object({
  protocolVersion: protocolVersion5,
  kind: external_exports.literal("ext-link-down"),
  linkId,
  reason: closeReason2
}).strict();
var ExtBusySchema = external_exports.object({
  protocolVersion: protocolVersion5,
  kind: external_exports.literal("ext-busy"),
  busy: external_exports.boolean()
}).strict();
var ExtSessionOpenSchema = external_exports.object({
  protocolVersion: protocolVersion5,
  kind: external_exports.literal("ext-session-open"),
  linkId,
  ticketHash: external_exports.string().regex(EXT_TICKET_HASH_PATTERN),
  expiresAt: TimestampMsSchema,
  who: LinkWhoSchema
}).strict();
var ExtSessionOpenedSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion5, kind: external_exports.literal("ext-session-opened"), linkId, ok: external_exports.literal(true) }).strict(),
  external_exports.object({ protocolVersion: protocolVersion5, kind: external_exports.literal("ext-session-opened"), linkId, ok: external_exports.literal(false), error: external_exports.object({ code: external_exports.string().min(1).max(64) }).strict() }).strict()
]);
var ExtSessionCloseSchema = external_exports.object({
  protocolVersion: protocolVersion5,
  kind: external_exports.literal("ext-session-close"),
  linkId,
  reason: closeReason2
}).strict();
var ExtLinkListenerCloseSchema = external_exports.object({
  protocolVersion: protocolVersion5,
  kind: external_exports.literal("ext-link-listener-close"),
  reason: external_exports.literal("permission_revoked")
}).strict();
var ExtProviderToCoreSchema = external_exports.union([ExtEndpointSchema, ExtLinkUpSchema, ExtLinkDownSchema, ExtBusySchema, ExtSessionOpenedSchema]);
var ExtCoreToProviderSchema = external_exports.discriminatedUnion("kind", [ExtSessionOpenSchema, ExtSessionCloseSchema, ExtLinkListenerCloseSchema]);
var ExternalHostLinksSchema = external_exports.object({
  path: external_exports.string().regex(EXT_LINK_PATH_PATTERN),
  challengeSecret: external_exports.string().regex(EXT_LINK_SECRET_PATTERN)
}).strict();

var PLUGIN_BACKEND_CHANNELS = Object.freeze({
  STATUS: "plugin-backend:status",
  PROBE: "plugin-backend:probe",
  LINKS: "plugin-backend:links"
});
var EXTERNAL_HOST_PROTOCOL_VERSION = 1;
var EXTERNAL_HOST_VERSION = "1.0.0";
var EXTERNAL_HOST_MAX_RESULT_BYTES = 64 * 1024;
var protocolVersion6 = external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION);
var hostVersion = external_exports.literal(EXTERNAL_HOST_PROTOCOL_VERSION);
var pluginId6 = external_exports.string().regex(IDENTIFIER_PATTERN);
var methodName = external_exports.string().min(1).max(64).regex(/^[A-Za-z0-9._@-]+$/);
var errorCode2 = external_exports.string().min(3).max(96).regex(/^[a-z0-9_]+$/);
var settingValues = external_exports.record(external_exports.string().regex(/^[A-Za-z0-9._-]{1,64}$/), external_exports.union([external_exports.boolean(), external_exports.number().finite(), external_exports.string().max(1024)])).refine((values) => Object.keys(values).length <= 16);
var BACKEND_RESIDENCY_LEVELS = ["on-demand", "resident"];
var BACKEND_RESIDENCY_REASONS = ["resident_not_granted", "resident_inactive", "resident_budget_exceeded", "resident_crash_budget_exhausted", "resident_boot_failed", "resident_artifact_revoked", "resident_revalidation_failed", "resident_policy_error"];
var PluginBackendResidencyV1Schema = external_exports.object({
  requested: external_exports.boolean(),
  level: external_exports.enum(BACKEND_RESIDENCY_LEVELS),
  reason: external_exports.enum(BACKEND_RESIDENCY_REASONS).nullable()
}).strict().refine((value) => value.level === "resident" ? value.requested && value.reason === null : value.requested || value.reason === null);
var BACKEND_RESIDENCY_UNREQUESTED = Object.freeze({ requested: false, level: "on-demand", reason: null });
var ExternalResidencyMessageSchema = external_exports.object({ protocolVersion: hostVersion, kind: external_exports.literal("ext-residency"), residency: PluginBackendResidencyV1Schema }).strict();
var ExternalSettingsMessageSchema = external_exports.object({ protocolVersion: hostVersion, kind: external_exports.literal("ext-settings"), enabled: external_exports.boolean(), values: settingValues }).strict();
var ExternalPermissionRevokedMessageSchema = external_exports.object({ protocolVersion: hostVersion, kind: external_exports.literal("ext-permission-revoked"), requestId: external_exports.string().regex(/^[a-f0-9]{16}$/), permission: external_exports.string().min(1).max(96) }).strict();
var ExternalPermissionRevokedAckMessageSchema = external_exports.object({ protocolVersion: hostVersion, kind: external_exports.literal("ext-permission-revoked-ack"), requestId: external_exports.string().regex(/^[a-f0-9]{16}$/) }).strict();
var ExternalHostInitSchema = external_exports.object({
  version: hostVersion,
  pluginId: pluginId6,
  installDir: external_exports.string().min(1).max(1024),
  dataDir: external_exports.string().min(1).max(1024),
  entry: external_exports.string().min(1).max(1024),
  assetPacks: external_exports.record(external_exports.string().min(1).max(96), external_exports.string().min(1).max(1024)),
  allowAddons: external_exports.boolean(),
  corePackaged: external_exports.boolean(),
  grantedPermissions: external_exports.array(external_exports.string().min(1).max(96)).max(64).default([]),
  heartbeatMs: external_exports.number().int().min(50).max(3e4).optional(),
  settingsEnabled: external_exports.boolean().optional(),
  settings: settingValues.optional(),
  links: ExternalHostLinksSchema.optional(),
  residency: PluginBackendResidencyV1Schema.optional()
}).strict();
var ExternalSelfCheckReportSchema = external_exports.object({
  ok: external_exports.boolean(),
  code: errorCode2.nullable(),
  allowAddons: external_exports.boolean(),
  probes: external_exports.record(external_exports.string().max(48), external_exports.string().max(64))
}).strict();
var ExternalSelfCheckMessageSchema = external_exports.object({
  protocolVersion: hostVersion,
  kind: external_exports.literal("ext-self-check"),
  report: ExternalSelfCheckReportSchema
}).strict();
var ExternalStatsMessageSchema = external_exports.object({
  protocolVersion: hostVersion,
  kind: external_exports.literal("ext-stats"),
  rssKb: external_exports.number().nonnegative()
}).strict();
var ExternalCallMessageSchema = external_exports.object({
  protocolVersion: hostVersion,
  kind: external_exports.literal("ext-call"),
  requestId: external_exports.string().min(1).max(64),
  method: methodName,
  params: external_exports.unknown()
}).strict();
var ExternalResultMessageSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: hostVersion, kind: external_exports.literal("ext-result"), requestId: external_exports.string().min(1).max(64), ok: external_exports.literal(true), value: external_exports.unknown() }).strict(),
  external_exports.object({ protocolVersion: hostVersion, kind: external_exports.literal("ext-result"), requestId: external_exports.string().min(1).max(64), ok: external_exports.literal(false), error: external_exports.object({ code: errorCode2, message: external_exports.string().max(512) }).strict() }).strict()
]);
var BACKEND_STATES = ["idle", "starting", "running", "stopping", "failed"];
var BACKEND_STOP_REASONS = ["idle", "memory_exceeded", "disabled", "crashed", "shutdown", "uninstalled", "hung", "recycled", "revalidated"];
var PluginBackendStatusV1Schema = external_exports.object({
  pluginId: pluginId6,
  state: external_exports.enum(BACKEND_STATES),
  pid: external_exports.number().int().nonnegative().nullable(),
  startedAt: external_exports.string().max(40).nullable(),
  lastActiveAt: external_exports.string().max(40).nullable(),
  starts: external_exports.number().int().nonnegative(),
  crashes: external_exports.number().int().nonnegative(),
  lastStartMs: external_exports.number().nonnegative().nullable(),
  lastVerifyMs: external_exports.number().nonnegative().nullable(),
  rssMB: external_exports.number().nonnegative().nullable(),
  memoryLimitMB: external_exports.number().int().positive(),
  idleUnloadSec: external_exports.number().int().nonnegative(),
  maxSessions: external_exports.number().int().positive(),
  inFlight: external_exports.number().int().nonnegative(),
  allowAddons: external_exports.boolean(),
  failureCode: errorCode2.nullable(),
  lastStopReason: external_exports.enum(BACKEND_STOP_REASONS).nullable(),
  selfCheck: ExternalSelfCheckReportSchema.nullable(),
  residency: PluginBackendResidencyV1Schema
}).strict();
var PluginBackendStatusListV1Schema = external_exports.object({
  protocolVersion: protocolVersion6,
  backends: external_exports.array(PluginBackendStatusV1Schema).max(256)
}).strict();
var PluginBackendProbeResultV1Schema = external_exports.object({
  pluginId: pluginId6,
  coldStart: external_exports.boolean(),
  totalMs: external_exports.number().nonnegative(),
  core: external_exports.unknown(),
  plugin: external_exports.discriminatedUnion("ok", [
    external_exports.object({ ok: external_exports.literal(true), value: external_exports.unknown() }).strict(),
    external_exports.object({ ok: external_exports.literal(false), code: errorCode2, message: external_exports.string().max(240).optional() }).strict()
  ]),
  status: PluginBackendStatusV1Schema
}).strict();
var PluginBackendLinkRowV1Schema = external_exports.object({
  linkId: external_exports.string().regex(/^[0-9a-f]{32}$/),
  consumer: external_exports.string().min(1).max(128),
  providerId: pluginId6,
  category: external_exports.string().min(1).max(96),
  scope: external_exports.enum(["use", "describe"]),
  state: external_exports.enum(["issued", "up"]),
  group: external_exports.string().max(48).nullable(),
  mode: external_exports.enum(["session", "call"]).nullable(),
  highRisk: external_exports.string().max(48).nullable(),
  ageMs: external_exports.number().int().nonnegative()
}).strict();
var PluginBackendEndpointRowV1Schema = external_exports.object({
  category: external_exports.string().min(1).max(96),
  providerId: pluginId6,
  status: external_exports.enum(["ready", "starting", "stopped", "blocked"]),
  dataClass: external_exports.enum(["local", "cloud"])
}).strict();
var PluginBackendLinksV1Schema = external_exports.object({
  protocolVersion: protocolVersion6,
  links: external_exports.array(PluginBackendLinkRowV1Schema).max(512),
  endpoints: external_exports.array(PluginBackendEndpointRowV1Schema).max(512)
}).strict();
var PluginBackendStatusRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion6 }).strict();
var PluginBackendLinksRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion6 }).strict();
var PluginBackendProbeRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion6, pluginId: pluginId6 }).strict();
var envelope2 = (value) => external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion6, ok: external_exports.literal(true), value }).strict(),
  external_exports.object({ protocolVersion: protocolVersion6, ok: external_exports.literal(false), error: PluginRuntimeErrorV1Schema }).strict()
]);
var PluginBackendStatusEnvelopeV1Schema = envelope2(PluginBackendStatusListV1Schema);
var PluginBackendProbeEnvelopeV1Schema = envelope2(PluginBackendProbeResultV1Schema);
var PluginBackendLinksEnvelopeV1Schema = envelope2(PluginBackendLinksV1Schema);

var CORE_CALLER_ID = "core";
var TEXT_INPUT_CHANNELS = Object.freeze({
  STATE: "plugin-text-input:state",
  SUBMIT: "plugin-text-input:submit"
});
var PLUGIN_INPUT_CHANNELS = Object.freeze({
  REQUEST: "plugin-view:input",
  EVENT: "plugin-view:input-event"
});
var TEXT_INPUT_LIMITS = Object.freeze({
  textBytes: 4096,
  inputsPerSecond: 5,
  pendingInputs: 64,
  ackTimeoutMs: 5e3
});
var CORE_INPUT_SOURCES = Object.freeze(["voice", "typed", "schedule"]);
var TEXT_INPUT_INTERRUPT_REASONS = Object.freeze(["escape"]);
var TEXT_INPUT_ACK_RESULTS = Object.freeze(["accepted", "dropped", "busy"]);
var TEXT_INPUT_SUBMIT_ERRORS = Object.freeze([
  "no_input_target",
  "input_invalid",
  "message_too_large",
  "target_not_ready",
  "target_not_visible",
  "rate_limited",
  "busy",
  "ack_timeout",
  "delivery_failed",
  "plugin_text_input_forbidden",
  "plugin_text_input_validation",
  "plugin_text_input_failed"
]);
var PLUGIN_INPUT_ERRORS = Object.freeze(["plugin_not_active", "not_granted", "view_not_visible", "request_invalid", "unavailable"]);
var protocolVersion7 = external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION);
var pluginId7 = external_exports.string().min(3).max(96).regex(IDENTIFIER_PATTERN);
var inputId = external_exports.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
var reason = external_exports.string().regex(/^[a-z0-9_]{1,32}$/);
var utterance = external_exports.object({ startMs: external_exports.number().int().min(0), endMs: external_exports.number().int().min(0), sourceId: external_exports.string().regex(/^[a-f0-9]{32}$/).optional(), utteranceId: external_exports.string().regex(/^[a-f0-9]{32}$/).optional() }).strict().refine((value) => value.endMs >= value.startMs, { message: "endMs must not precede startMs" });
var utf8Bytes = (value) => new TextEncoder().encode(value).length;
var textInputText = external_exports.string().min(1).refine((value) => utf8Bytes(value) <= TEXT_INPUT_LIMITS.textBytes, { message: "text too large" });
var TextInputDeliveredSchema = external_exports.object({
  type: external_exports.literal("input"),
  inputId,
  text: textInputText,
  source: external_exports.enum(CORE_INPUT_SOURCES),
  callerId: external_exports.literal(CORE_CALLER_ID),
  receivedAtMs: external_exports.number().int().min(0),
  arrivedWhileSpeaking: external_exports.boolean(),
  utterance: utterance.optional()
}).strict();
var TextInputInterruptDeliveredSchema = external_exports.object({ type: external_exports.literal("interrupt"), reason: external_exports.enum(TEXT_INPUT_INTERRUPT_REASONS), receivedAtMs: external_exports.number().int().min(0) }).strict();
var TextInputAckValueSchema = external_exports.object({ result: external_exports.enum(TEXT_INPUT_ACK_RESULTS), reason: reason.optional() }).strict();
var PluginInputRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("provide") }).strict(),
  external_exports.object({ op: external_exports.literal("stop") }).strict(),
  external_exports.object({ op: external_exports.literal("setSpeaking"), speaking: external_exports.boolean() }).strict(),
  external_exports.object({ op: external_exports.literal("state") }).strict(),
  external_exports.object({ op: external_exports.literal("ack"), inputId, result: external_exports.enum(TEXT_INPUT_ACK_RESULTS), reason: reason.optional() }).strict()
]);
var PluginInputOwnStateSchema = external_exports.object({ registered: external_exports.boolean(), current: external_exports.boolean() }).strict();
var PluginInputEnvelopeSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ ok: external_exports.literal(true), value: external_exports.unknown() }).strict(),
  external_exports.object({ ok: external_exports.literal(false), error: external_exports.enum(PLUGIN_INPUT_ERRORS) }).strict()
]);
var PluginInputEventSchema = external_exports.discriminatedUnion("type", [TextInputDeliveredSchema, TextInputInterruptDeliveredSchema]);
var TextInputStateRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion7 }).strict();
var TextInputSubmitRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion7, text: textInputText }).strict();
var TextInputStateV1Schema = external_exports.object({
  protocolVersion: protocolVersion7,
  target: external_exports.object({ id: pluginId7, name: external_exports.string().max(96), visible: external_exports.boolean() }).strict().nullable(),
  registered: external_exports.array(external_exports.object({ id: pluginId7, name: external_exports.string().max(96), current: external_exports.boolean() }).strict()).max(16)
}).strict();
var TextInputSubmitValueV1Schema = external_exports.object({
  result: external_exports.enum(TEXT_INPUT_ACK_RESULTS),
  reason: reason.optional(),
  target: external_exports.object({ id: pluginId7, name: external_exports.string().max(96) }).strict()
}).strict();
var errorBody = external_exports.object({ code: external_exports.string().min(1).max(96).regex(/^[a-z0-9_]+$/), message: external_exports.string().min(1).max(512) }).strict();
var TextInputStateEnvelopeV1Schema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion7, ok: external_exports.literal(true), value: TextInputStateV1Schema }).strict(),
  external_exports.object({ protocolVersion: protocolVersion7, ok: external_exports.literal(false), error: errorBody }).strict()
]);
var TextInputSubmitEnvelopeV1Schema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion7, ok: external_exports.literal(true), value: TextInputSubmitValueV1Schema }).strict(),
  external_exports.object({ protocolVersion: protocolVersion7, ok: external_exports.literal(false), error: errorBody }).strict()
]);

var VOICE_INPUT_CHANNELS = Object.freeze({
  STATE: "plugin-voice-input:state",
  SET_ENABLED: "plugin-voice-input:set-enabled",
  CHANGED: "plugin-voice-input:changed",
  CAPTURE_FRAME: "core-voice-capture:frame"
});
var VOICE_INPUT_LIMITS = Object.freeze({
  chunkMs: 80,
  sampleRate: 16e3,
  captureFrameBytes: 2560,
  restartsPerMinute: 3
});
var VOICE_INPUT_STATUSES = Object.freeze(["off", "starting", "listening", "unavailable"]);
var VOICE_INPUT_REASONS = Object.freeze([
  "no_recognizer",
  "recognizer_selection_required",
  "recognizer_not_ready",
  "recognizer_not_allowed",
  "recognizer_busy",
  "recognizer_gone",
  "recognizer_error",
  "model_missing",
  "no_input_target",
  "consent_denied",
  "os_denied",
  "no_microphone",
  "capture_failed"
]);
var PLUGIN_VOICE_ERRORS = Object.freeze(["plugin_not_active", "request_invalid", "unavailable"]);
var protocolVersion8 = external_exports.literal(PLUGIN_RUNTIME_PROTOCOL_VERSION);
var pluginId8 = external_exports.string().min(3).max(96).regex(IDENTIFIER_PATTERN);
var count = external_exports.number().int().min(0);
var VoiceCaptureFrameV1Schema = external_exports.object({
  protocolVersion: protocolVersion8,
  data: external_exports.instanceof(ArrayBuffer).refine((frame2) => frame2.byteLength === VOICE_INPUT_LIMITS.captureFrameBytes)
}).strict();
var VoiceInputStateV1Schema = external_exports.object({
  protocolVersion: protocolVersion8,
  status: external_exports.enum(VOICE_INPUT_STATUSES),
  enabled: external_exports.boolean(),
  capturing: external_exports.boolean(),
  available: external_exports.boolean(),
  reason: external_exports.enum(VOICE_INPUT_REASONS).nullable(),
  recognizer: external_exports.object({ id: pluginId8, name: external_exports.string().max(96), version: external_exports.string().max(32), signer: external_exports.enum(PLUGIN_SIGNER_KINDS) }).strict().nullable(),
  target: external_exports.object({ id: pluginId8, name: external_exports.string().max(96) }).strict().nullable(),
  lastDeliveryError: external_exports.string().max(96).nullable(),
  stats: external_exports.object({ chunksSent: count, finals: count, delivered: count }).strict()
}).strict();
var VoiceInputStateRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion8 }).strict();
var VoiceInputSetEnabledRequestV1Schema = external_exports.object({ protocolVersion: protocolVersion8, enabled: external_exports.boolean(), consented: external_exports.boolean().optional() }).strict();
var errorBody2 = external_exports.object({ code: external_exports.string().min(1).max(96).regex(/^[a-z0-9_]+$/), message: external_exports.string().min(1).max(512) }).strict();
var VoiceInputStateEnvelopeV1Schema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ protocolVersion: protocolVersion8, ok: external_exports.literal(true), value: VoiceInputStateV1Schema }).strict(),
  external_exports.object({ protocolVersion: protocolVersion8, ok: external_exports.literal(false), error: errorBody2 }).strict()
]);
var PluginVoiceRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("state") }).strict()
]);
var PluginVoiceStateSchema = external_exports.object({
  status: external_exports.enum(VOICE_INPUT_STATUSES),
  isInputTarget: external_exports.boolean()
}).strict();
var PluginVoiceEnvelopeSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ ok: external_exports.literal(true), value: PluginVoiceStateSchema }).strict(),
  external_exports.object({ ok: external_exports.literal(false), error: external_exports.enum(PLUGIN_VOICE_ERRORS) }).strict()
]);

var PLUGIN_BACKEND_INVOKE_CHANNEL = "plugin-view:backend-invoke";
var PLUGIN_BACKEND_INVOKE_LIMITS = Object.freeze({ methods: 32, methodLength: 64, payloadBytes: 64 * 1024, inFlight: 8, timeoutMs: 3e4 });
var PLUGIN_BACKEND_INVOKE_ERROR_CODES = Object.freeze([
  "plugin_not_installed",
  "plugin_disabled",
  "plugin_permission_denied",
  "backend_method_not_allowed",
  "backend_invoke_invalid",
  "backend_invoke_too_large",
  "backend_invoke_timeout",
  "plugin_backend_crashed",
  "plugin_backend_unavailable"
]);
var method = external_exports.string().min(1).max(PLUGIN_BACKEND_INVOKE_LIMITS.methodLength).regex(/^[A-Za-z0-9._@-]+$/);
var jsonValue = external_exports.lazy(() => external_exports.union([
  external_exports.null(),
  external_exports.boolean(),
  external_exports.number().finite(),
  external_exports.string(),
  external_exports.array(jsonValue).max(4096),
  external_exports.record(external_exports.string(), jsonValue)
]));
var PluginBackendInvokeRequestV1Schema = external_exports.object({ method, params: jsonValue }).strict();
var PluginBackendInvokeResultV1Schema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ ok: external_exports.literal(true), value: jsonValue }).strict(),
  external_exports.object({ ok: external_exports.literal(false), error: external_exports.enum(PLUGIN_BACKEND_INVOKE_ERROR_CODES) }).strict()
]);
function pluginBackendInvokePayloadBytes(value) {
  try {
    const encoded = JSON.stringify(value);
    return encoded === void 0 ? null : new TextEncoder().encode(encoded).byteLength;
  } catch {
    return null;
  }
}

var PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION = PLUGIN_RUNTIME_PROTOCOL_VERSION;
var PLUGIN_REMOTE_SURFACE_PATH = "/web/v1/plugin-surfaces";
var PLUGIN_REMOTE_SURFACE_API_FAMILIES = Object.freeze([
  "storage",
  "settings",
  "secrets",
  "assetPacks",
  "agentAvatar",
  "backend",
  "capability",
  "ai"
]);
var PLUGIN_REMOTE_SURFACE_ERROR_CODES = Object.freeze([
  "unauthorized",
  "forbidden",
  "invalid_request",
  "not_found",
  "not_ready",
  "not_remote_visible",
  "ticket_expired",
  "ticket_invalid",
  "artifact_invalid",
  "grant_denied",
  "api_unavailable",
  "surface_closed"
]);
var PluginRemoteSurfaceByteArrayV1Schema = external_exports.array(external_exports.number().int().min(0).max(255)).max(32 * 1024);
var storageUploadPath = external_exports.string().min(1).max(240).refine((value) => !value.startsWith("/") && !/[\\:\u0000-\u001f]/u.test(value) && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."));
var PluginRemoteSurfaceUploadTargetV1Schema = external_exports.discriminatedUnion("api", [
  external_exports.object({ api: external_exports.literal("storage"), op: external_exports.literal("write"), path: storageUploadPath, append: external_exports.boolean().optional() }).strict(),
  external_exports.object({ api: external_exports.literal("ai"), op: external_exports.literal("send"), sessionId: external_exports.string().regex(/^[0-9a-f]{32}$/), text: external_exports.string().max(8e3), mime: external_exports.enum(["image/jpeg", "image/png"]) }).strict()
]);
var identifier2 = external_exports.string().regex(/^[a-z0-9][a-z0-9._-]{1,95}$/);
var surfaceId = external_exports.string().regex(/^[A-Za-z0-9_-]{32,96}$/);
var requestId2 = external_exports.string().regex(/^[A-Za-z0-9_-]{8,96}$/);
var opaquePayload = external_exports.unknown();
var PluginRemoteSurfaceRequestV1Schema = external_exports.discriminatedUnion("op", [
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), op: external_exports.literal("list") }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), op: external_exports.literal("open"), pluginId: identifier2, viewId: identifier2 }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), op: external_exports.literal("close"), surfaceId }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), op: external_exports.literal("poll"), surfaceId, after: external_exports.number().int().nonnegative() }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), op: external_exports.literal("upload"), surfaceId, uploadId: requestId2, purpose: external_exports.enum(["storage-write", "ai-image"]), target: PluginRemoteSurfaceUploadTargetV1Schema, chunkIndex: external_exports.number().int().nonnegative().max(256), bytes: PluginRemoteSurfaceByteArrayV1Schema, complete: external_exports.boolean() }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), op: external_exports.literal("call"), surfaceId, requestId: requestId2, api: external_exports.enum(PLUGIN_REMOTE_SURFACE_API_FAMILIES), payload: opaquePayload }).strict()
]).refine((value) => value.op !== "upload" || value.purpose === "storage-write" && value.target.api === "storage" || value.purpose === "ai-image" && value.target.api === "ai");
var PluginRemoteSurfaceDescriptorV1Schema = external_exports.object({
  surfaceId,
  pluginId: identifier2,
  viewId: identifier2,
  title: external_exports.string().min(1).max(48),
  artifactSha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: external_exports.number().int().positive(),
  src: external_exports.string().min(1).max(2048).startsWith(`${PLUGIN_REMOTE_SURFACE_PATH}/assets/`),
  handshakeNonce: external_exports.string().regex(/^[A-Za-z0-9_-]{32,96}$/)
}).strict();
var PluginRemoteSurfaceViewV1Schema = external_exports.object({ pluginId: identifier2, viewId: identifier2, title: external_exports.string().min(1).max(48) }).strict();
var success = external_exports.discriminatedUnion("op", [
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), ok: external_exports.literal(true), op: external_exports.literal("list"), surfaces: external_exports.array(PluginRemoteSurfaceViewV1Schema).max(96) }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), ok: external_exports.literal(true), op: external_exports.literal("open"), surface: PluginRemoteSurfaceDescriptorV1Schema }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), ok: external_exports.literal(true), op: external_exports.literal("close"), surfaceId }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), ok: external_exports.literal(true), op: external_exports.literal("poll"), surfaceId, cursor: external_exports.number().int().nonnegative(), events: external_exports.array(external_exports.object({ id: external_exports.number().int().positive(), type: external_exports.enum(["capability", "ai"]), payload: external_exports.unknown() }).strict()).max(64) }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), ok: external_exports.literal(true), op: external_exports.literal("upload"), uploadId: requestId2, receivedBytes: external_exports.number().int().nonnegative(), complete: external_exports.boolean() }).strict(),
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), ok: external_exports.literal(true), op: external_exports.literal("call"), requestId: requestId2, result: PluginCoreEnvelopeSchema }).strict()
]);
var PluginRemoteSurfaceEnvelopeV1Schema = external_exports.union([
  success,
  external_exports.object({ protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION), ok: external_exports.literal(false), error: external_exports.enum(PLUGIN_REMOTE_SURFACE_ERROR_CODES) }).strict()
]);
var PluginRemoteSurfaceFrameReadyV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION),
  kind: external_exports.literal("ready"),
  nonce: external_exports.string().regex(/^[A-Za-z0-9_-]{32,96}$/)
}).strict();
var PluginRemoteSurfaceFrameInitV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION),
  kind: external_exports.literal("init"),
  pluginId: identifier2,
  viewId: identifier2,
  artifactSha256: external_exports.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: external_exports.number().int().positive(),
  nonce: external_exports.string().regex(/^[A-Za-z0-9_-]{32,96}$/)
}).strict();
var PluginRemoteSurfaceFrameCallV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION),
  kind: external_exports.literal("call"),
  requestId: requestId2,
  api: external_exports.enum(PLUGIN_REMOTE_SURFACE_API_FAMILIES),
  payload: opaquePayload
}).strict();
var PluginRemoteSurfaceFrameResultV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION),
  kind: external_exports.literal("result"),
  requestId: requestId2,
  result: PluginCoreEnvelopeSchema
}).strict();
var PluginRemoteSurfaceFrameEventV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(PLUGIN_REMOTE_SURFACE_PROTOCOL_VERSION),
  kind: external_exports.literal("event"),
  id: external_exports.number().int().positive(),
  type: external_exports.enum(["capability", "ai"]),
  payload: external_exports.unknown()
}).strict();
var PluginRemoteSurfaceEventV1Schema = external_exports.object({
  type: external_exports.enum(["capability", "ai"]),
  payload: external_exports.unknown()
}).strict();

var PLUGIN_PROGRAM_PERMISSION_SCOPES_V1 = Object.freeze({
  "program:conversation:dispatch": "conversation:dispatch",
  "program:conversation:read": "conversation:read",
  "program:conversation:followup": "conversation:followup",
  "program:data:projects:read": "data:projects:read",
  "program:data:projects:write": "data:projects:write",
  "program:data:milestones:read": "data:milestones:read",
  "program:data:milestones:write": "data:milestones:write",
  "program:data:tasks:read": "data:tasks:read",
  "program:data:tasks:write": "data:tasks:write"
});
var PLUGIN_PROGRAM_PERMISSION_OPERATIONS_V1 = Object.freeze({
  "program:conversation:dispatch": ["conversation.dispatch"],
  "program:conversation:read": ["conversation.read"],
  "program:conversation:followup": ["conversation.followUp"],
  "program:data:projects:read": ["data.projects.list", "data.projects.get"],
  "program:data:projects:write": ["data.projects.create", "data.projects.update", "data.projects.delete"],
  "program:data:milestones:read": ["data.milestones.list", "data.milestones.get"],
  "program:data:milestones:write": ["data.milestones.create", "data.milestones.update", "data.milestones.delete"],
  "program:data:tasks:read": ["data.tasks.list", "data.tasks.get"],
  "program:data:tasks:write": ["data.tasks.create", "data.tasks.update", "data.tasks.delete"]
});
var PLUGIN_PROGRAM_API_CHANNELS_V1 = Object.freeze({ REQUEST: "plugin-view:program-api" });
var PLUGIN_PROGRAM_OPERATION_NAMES_V1 = [
  "program.describe",
  "conversation.dispatch",
  "conversation.read",
  "conversation.followUp",
  "data.projects.list",
  "data.projects.get",
  "data.projects.create",
  "data.projects.update",
  "data.projects.delete",
  "data.milestones.list",
  "data.milestones.get",
  "data.milestones.create",
  "data.milestones.update",
  "data.milestones.delete",
  "data.tasks.list",
  "data.tasks.get",
  "data.tasks.create",
  "data.tasks.update",
  "data.tasks.delete"
];

var PLUGIN_HOST_AI_CHAT_TURN_EVENT = "turn";
var sessionId3 = AiChatSessionIdSchema;
var turnId = external_exports.string().regex(/^[0-9a-f]{16}$/);
var BASE64_IMAGE_CHARS = Math.ceil(AI_CHAT_LIMITS.imageBytes / 3) * 4;
var AI_BACKEND_SEND_PAYLOAD_BYTES = BASE64_IMAGE_CHARS + 64 * 1024;
var optionsOf = (schema) => schema instanceof external_exports.ZodUnion || schema instanceof external_exports.ZodDiscriminatedUnion ? schema.options : [];
var requestObjectVariants = (schema) => {
  if (schema instanceof external_exports.ZodObject) return [schema];
  return optionsOf(schema).flatMap(requestObjectVariants);
};
var requestVariants = requestObjectVariants(AiChatRequestSchema instanceof external_exports.ZodEffects ? AiChatRequestSchema.innerType() : AiChatRequestSchema);
var variantsFor = (op) => requestVariants.filter((candidate) => candidate.shape.op.safeParse(op).success);
var variant = (op) => {
  const found = variantsFor(op)[0];
  if (found === void 0) throw new Error(`ai chat request has no '${op}' variant`);
  return found;
};
var AiBackendImageSchema = external_exports.object({
  mime: external_exports.enum(["image/jpeg", "image/png"]),
  dataBase64: external_exports.string().min(1).max(BASE64_IMAGE_CHARS).regex(/^[A-Za-z0-9+/]+={0,2}$/)
}).strict();
var AiBackendRequestSchema = external_exports.discriminatedUnion("op", [
  variant("getOptions"),
  variant("openSession"),
  variant("send").omit({ image: true }).extend({ image: AiBackendImageSchema.optional() }),
  ...variantsFor("complete").map((candidate) => candidate.omit({ image: true }).extend({ image: AiBackendImageSchema.optional() })),
  variant("interrupt"),
  variant("close"),
  variant("attachSession")
]);
var AiChatBackendEventV1Schema = external_exports.object({
  protocolVersion: external_exports.literal(1),
  kind: external_exports.literal("ext-capability-event"),
  capabilityId: external_exports.literal(PLUGIN_HOST_DATA_CAPABILITIES.aiChat),
  event: external_exports.literal(PLUGIN_HOST_AI_CHAT_TURN_EVENT),
  sessionId: sessionId3,
  turnId,
  turn: AiChatTurnEventSchema
}).strict();
var SECRET_METHOD_FIELDS = Object.freeze({ get: ["name"], set: ["name", "value"], remove: ["name"], list: [], available: [] });

var IDENTITY_FIELDS = Object.freeze(["source", "callerId", "pluginId", "senderId"]);
var CLOSE_CODES = Object.freeze({
  consumer_closed: 1e3,
  view_hidden: 4001,
  view_occluded: 4002,
  view_closed: 4003,
  view_reloaded: 4004,
  provider_gone: 4005,
  provider_crashed: 4006,
  provider_closed: 4007,
  consumer_gone: 4008,
  rate_limited: 4009,
  idle_timeout: 4010,
  permission_revoked: 4011,
  protocol_error: 4012,
  shutdown: 4013
});
var CLOSE_REASONS = Object.freeze(Object.keys(CLOSE_CODES));
var HANDSHAKE_CLOSE_CODES = Object.freeze({ ticketInvalid: 4401, groupNotAuthorized: 4403, handshakeTimeout: 4408 });
var PROVIDER_CODES = Object.freeze([
  "capability_request_invalid",
  "session_not_found",
  "message_too_large",
  "data_too_large",
  "rate_limited",
  "capability_busy",
  "provider_not_ready",
  "provider_error",
  "not_configured",
  "auth_failed",
  "quota_exceeded",
  "network_unreachable",
  "unsupported_options",
  "not_supported",
  "job_not_found",
  "job_cancelled",
  "provider_lost",
  "content_refused",
  "blob_not_found",
  "blob_too_large"
]);
var CONTROL_PLANE_ERROR_CODES = Object.freeze([
  "capability_undeclared",
  "capability_unresolved",
  "provider_not_allowed",
  "provider_selection_required",
  "not_granted",
  "consent_denied",
  "consumer_limit",
  "view_not_visible",
  "plugin_not_active",
  "capability_unavailable",
  "provider_endpoint_unreachable"
]);
var CONSUMER_ERROR_CODES = Object.freeze(["open_timeout", "output_invalid"]);
var REJECT_CODES = Object.freeze([
  "capability_request_invalid",
  "unsupported_options",
  "message_too_large",
  "data_too_large",
  "rate_limited",
  "provider_not_ready",
  "session_not_found"
]);
var RETRY_AFTER_CODES = Object.freeze(["rate_limited", "capability_busy", "provider_not_ready"]);
var ALL_ERROR_CODES = Object.freeze([...PROVIDER_CODES, ...CONTROL_PLANE_ERROR_CODES, ...CONSUMER_ERROR_CODES]);
var DESCRIBE_METHODS = Object.freeze(["teamuq.describe", "teamuq.availability"]);
var RUN_LIMIT_MS = Object.freeze({
  "image-generate": 10 * 6e4,
  "image-edit": 10 * 6e4,
  "video-generate": 60 * 6e4,
  "speech-transcribe-file": 30 * 6e4
});
var DEFAULT_RUN_LIMIT_MS = 10 * 6e4;

var KNOWN = new Set(ALL_ERROR_CODES);
var PROVIDER = new Set(PROVIDER_CODES);
var RETRYABLE = new Set(RETRY_AFTER_CODES);
var REASON_CODE = Object.freeze({
  consumer_closed: "provider_lost",
  view_hidden: "view_not_visible",
  view_occluded: "view_not_visible",
  view_closed: "provider_lost",
  view_reloaded: "provider_lost",
  provider_gone: "capability_unresolved",
  provider_crashed: "provider_lost",
  provider_closed: "provider_lost",
  consumer_gone: "provider_lost",
  rate_limited: "rate_limited",
  idle_timeout: "open_timeout",
  permission_revoked: "not_granted",
  protocol_error: "provider_error",
  shutdown: "capability_unavailable"
});

var CHUNK = LINK_LIMITS.blobReadChunkBytes;

var encoder = new TextEncoder();

var REASON_BY_CODE = new Map(Object.entries(CLOSE_CODES).filter(([reason3]) => reason3 !== "consumer_closed").map(([reason3, code2]) => [code2, reason3]));

var INPUT_CLASS_WEIGHT = Object.freeze({ text: 0, audio: 1, "user-media": 2, "personal-data": 2, biometric: 3 });
var ROWS2 = [
  { id: "speech-transcribe", category: "teamuq.stt@1", version: 1, typePrefix: "Stt", modes: ["session"], agentCallable: { enabled: false, candidate: false }, inputClass: "audio", resourceClass: "cpu", residencyDefault: "warm", stability: "draft" },
  { id: "speech-synthesize", category: "teamuq.tts@1", version: 1, typePrefix: "Tts", modes: ["session", "job"], agentCallable: { enabled: false, candidate: false }, inputClass: "text", resourceClass: "cpu", residencyDefault: "warm", stability: "draft" },
  { id: "memory-store", category: "teamuq.memory@1", version: 1, typePrefix: "Memory", modes: ["call"], agentCallable: { enabled: false, candidate: false }, inputClass: "personal-data", resourceClass: "cpu", residencyDefault: "resident", stability: "draft" },
  { id: "doc-extract", category: "teamuq.doc@1", version: 1, typePrefix: "DocExtract", modes: ["call", "job"], agentCallable: { enabled: false, candidate: true }, inputClass: "user-media", resourceClass: "cpu", residencyDefault: "on-demand", stability: "draft" },
  { id: "image-generate", category: "teamuq.image@1", version: 1, typePrefix: "ImageGenerate", modes: ["job"], agentCallable: { enabled: false, candidate: false }, inputClass: "text", resourceClass: "gpu", residencyDefault: "on-demand", stability: "draft" },
  { id: "speech-transcribe-file", category: "teamuq.stt@1", version: 1, typePrefix: "SttFile", modes: ["job"], agentCallable: { enabled: false, candidate: false }, inputClass: "audio", resourceClass: "cpu", residencyDefault: "on-demand", stability: "proposed" },
  { id: "speech-wake", category: "teamuq.stt@1", version: 1, typePrefix: "Wake", modes: ["session"], agentCallable: { enabled: false, candidate: false }, inputClass: "audio", resourceClass: "cpu", residencyDefault: "resident", stability: "proposed" },
  { id: "audio-generate", category: "teamuq.audio@1", version: 1, typePrefix: "AudioGenerate", modes: ["job"], agentCallable: { enabled: false, candidate: false }, inputClass: "text", resourceClass: "gpu", residencyDefault: "on-demand", stability: "proposed" },
  { id: "audio-edit", category: "teamuq.stt@1", version: 1, typePrefix: "AudioEdit", modes: ["job"], agentCallable: { enabled: false, candidate: false }, inputClass: "audio", resourceClass: "gpu", residencyDefault: "on-demand", stability: "proposed" },
  { id: "image-edit", category: "teamuq.image@1", version: 1, typePrefix: "ImageEdit", modes: ["job"], agentCallable: { enabled: false, candidate: false }, inputClass: "user-media", resourceClass: "gpu", residencyDefault: "on-demand", stability: "proposed" },
  { id: "video-generate", category: "teamuq.video@1", version: 1, typePrefix: "VideoGenerate", modes: ["job"], agentCallable: { enabled: false, candidate: false }, inputClass: "text", resourceClass: "gpu", residencyDefault: "on-demand", stability: "proposed" },
  { id: "text-embed", category: "teamuq.text@1", version: 1, typePrefix: "TextEmbed", modes: ["call"], agentCallable: { enabled: false, candidate: false }, inputClass: "text", resourceClass: "cpu", residencyDefault: "on-demand", stability: "proposed" },
  { id: "personal-calendar", category: "teamuq.personal@1", version: 1, typePrefix: "Calendar", modes: ["call"], agentCallable: { enabled: false, candidate: false }, inputClass: "personal-data", resourceClass: "net", residencyDefault: "on-demand", stability: "proposed" },
  { id: "personal-contacts", category: "teamuq.personal@1", version: 1, typePrefix: "Contacts", modes: ["call"], agentCallable: { enabled: false, candidate: false }, inputClass: "personal-data", resourceClass: "net", residencyDefault: "on-demand", stability: "proposed" },
  { id: "notify-send", category: "teamuq.notify@1", version: 1, typePrefix: "Notify", modes: ["call"], agentCallable: { enabled: false, candidate: false }, inputClass: "text", resourceClass: "net", residencyDefault: "on-demand", stability: "proposed" },
  { id: "web-search", category: "teamuq.web@1", version: 1, typePrefix: "WebSearch", modes: ["call"], agentCallable: { enabled: false, candidate: false }, inputClass: "text", resourceClass: "net", residencyDefault: "on-demand", stability: "proposed" },
  { id: "speech-speaker", category: "teamuq.stt@1", version: 1, typePrefix: "Speaker", modes: ["call"], agentCallable: { enabled: false, candidate: false }, inputClass: "biometric", resourceClass: "cpu", residencyDefault: "on-demand", stability: "proposed" }
];
var GROUP_SPEC_DIRECTORY = Object.freeze(ROWS2.map((row) => Object.freeze({ ...row, modes: Object.freeze([...row.modes]), agentCallable: Object.freeze({ ...row.agentCallable }) })));

var BACKLOG_LIMIT = 512;
var EARLY_LIMIT = 64;
function toBytes(data) {
  if (data instanceof Uint8Array) return data.slice();
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  throw new TypeError("image.data must be a Uint8Array or an ArrayBuffer");
}
function createAiChatApi(ipc) {
  const sessions = /* @__PURE__ */ new Map();
  const early = /* @__PURE__ */ new Map();
  let subscribed = false;
  const call = async (request) => {
    const envelope3 = AiChatEnvelopeSchema.parse(await ipc.invoke(PLUGIN_AI_CHANNELS.REQUEST, request));
    if (!envelope3.ok) throw new Error(envelope3.error);
    return envelope3.value;
  };
  const flush = (state2) => {
    const pending = state2.backlog;
    state2.backlog = [];
    for (const event of pending) for (const listener of [...state2.listeners]) listener({ ...event.event, turnId: event.turnId });
  };
  const dispatch = (event) => {
    const state2 = sessions.get(event.sessionId);
    if (state2 === void 0) {
      const queue = early.get(event.sessionId) ?? [];
      if (queue.length < EARLY_LIMIT) queue.push(event);
      early.set(event.sessionId, queue);
      if (early.size > EARLY_LIMIT) early.delete(early.keys().next().value);
      return;
    }
    if (state2.listeners.size > 0) for (const listener of [...state2.listeners]) listener({ ...event.event, turnId: event.turnId });
    else if (state2.backlog.length < BACKLOG_LIMIT) state2.backlog.push(event);
  };
  const ensureSubscribed = () => {
    if (subscribed) return;
    subscribed = true;
    ipc.on(PLUGIN_AI_CHANNELS.EVENT, (_event, payload) => {
      const parsed = AiChatViewEventSchema.safeParse(payload);
      if (parsed.success) dispatch(parsed.data);
    });
  };
  const wrap = (sessionId5, effective2, turn) => {
    ensureSubscribed();
    const state2 = sessions.get(sessionId5) ?? { listeners: /* @__PURE__ */ new Set(), backlog: [] };
    sessions.set(sessionId5, state2);
    for (const event of early.get(sessionId5) ?? []) dispatch(event);
    early.delete(sessionId5);
    return Object.freeze({
      sessionId: sessionId5,
      effective: Object.freeze({ ...effective2 }),
      turn: turn === null ? null : Object.freeze({ ...turn }),
      send: async (input) => {
        const body = { text: "", ...input, op: "send", sessionId: sessionId5 };
        if (input.image !== void 0) body["image"] = { ...input.image, data: toBytes(input.image.data) };
        return AiChatSentSchema.parse(await call(body));
      },
      onEvent: (listener) => {
        if (typeof listener !== "function") throw new TypeError("onEvent requires a function");
        state2.listeners.add(listener);
        setTimeout(() => flush(state2), 0);
        return () => {
          state2.listeners.delete(listener);
        };
      },
      interrupt: async () => {
        await call({ op: "interrupt", sessionId: sessionId5 });
      },
      close: async () => {
        try {
          await call({ op: "close", sessionId: sessionId5 });
        } finally {
          setTimeout(() => sessions.delete(sessionId5), 5e3);
        }
      }
    });
  };
  return Object.freeze({
    getOptions: async () => AiChatOptionsSchema.parse(await call({ op: "getOptions" })),
    openSession: async (options) => {
      const request = options;
      if (typeof request["resume"] === "string") {
        const attached = AiChatAttachedSchema.parse(await call({ op: "attachSession", sessionId: request["resume"], ...request["taskId"] === void 0 ? {} : { taskId: request["taskId"] } }));
        return wrap(attached.sessionId, attached.effective, attached.turn);
      }
      const opened = AiChatOpenedSchema.parse(await call({ ...options, op: "openSession" }));
      return wrap(opened.sessionId, opened.effective, null);
    }
  });
}

var BACKLOG_LIMIT2 = 256;
var EARLY_LIMIT2 = 64;
function createCapabilityApi(ipc) {
  const sessions = /* @__PURE__ */ new Map();
  const early = /* @__PURE__ */ new Map();
  const changeListeners = /* @__PURE__ */ new Set();
  let subscribed = false;
  const call = async (channel, request) => {
    const envelope3 = CapabilityEnvelopeSchema.parse(await ipc.invoke(channel, request));
    if (!envelope3.ok) throw Object.assign(new Error(envelope3.error), { code: envelope3.error, ...envelope3.message === void 0 ? {} : { detail: envelope3.message } });
    return envelope3.value;
  };
  const flush = (state2) => {
    if (state2.messageListeners.size > 0) {
      const pending = state2.backlog;
      state2.backlog = [];
      for (const [message, data] of pending) for (const listener of [...state2.messageListeners]) {
        try {
          listener(message, data);
        } catch {
        }
      }
    }
    if (state2.closedReason !== null) {
      const reason3 = state2.closedReason;
      for (const listener of [...state2.closeListeners]) listener(reason3);
    }
  };
  const dispatch = (event) => {
    if (event.kind === "change") {
      for (const listener of [...changeListeners]) listener(event);
      return;
    }
    const state2 = sessions.get(event.sessionId);
    if (state2 === void 0) {
      const queue = early.get(event.sessionId) ?? [];
      if (queue.length < EARLY_LIMIT2) queue.push(event);
      early.set(event.sessionId, queue);
      if (early.size > EARLY_LIMIT2) early.delete(early.keys().next().value);
      return;
    }
    if (event.kind === "message") {
      if (state2.messageListeners.size > 0) for (const listener of [...state2.messageListeners]) {
        try {
          listener(event.message, event.data);
        } catch {
        }
      }
      else if (state2.backlog.length < BACKLOG_LIMIT2) state2.backlog.push([event.message, event.data]);
      return;
    }
    state2.closedReason = event.reason;
    flush(state2);
    setTimeout(() => sessions.delete(event.sessionId), 5e3);
  };
  const ensureSubscribed = () => {
    if (subscribed) return;
    subscribed = true;
    ipc.on(PLUGIN_CAPABILITY_CHANNELS.EVENT, (_event, payload) => {
      const link = LinkCapabilityEventSchema.safeParse(payload);
      if (link.success) {
        for (const listener of [...changeListeners]) listener(link.data);
        return;
      }
      const parsed = CapabilityEventSchema.safeParse(payload);
      if (parsed.success) dispatch(parsed.data);
    });
  };
  const open = async (capability, options) => {
    ensureSubscribed();
    const opened = CapabilityOpenedSchema.parse(await call(PLUGIN_CAPABILITY_CHANNELS.REQUEST, { op: "open", capability: String(capability), ...options === void 0 ? {} : { options } }));
    const state2 = { sessionId: opened.sessionId, messageListeners: /* @__PURE__ */ new Set(), closeListeners: /* @__PURE__ */ new Set(), backlog: [], closedReason: null };
    sessions.set(opened.sessionId, state2);
    const queued = early.get(opened.sessionId) ?? [];
    early.delete(opened.sessionId);
    for (const event of queued) dispatch(event);
    return Object.freeze({
      sessionId: opened.sessionId,
      capability: opened.capability,
      provider: Object.freeze({ ...opened.provider }),
      onMessage: (listener) => {
        if (typeof listener !== "function") throw new TypeError("onMessage requires a function");
        state2.messageListeners.add(listener);
        setTimeout(() => flush(state2), 0);
        return () => {
          state2.messageListeners.delete(listener);
        };
      },
      onClose: (listener) => {
        if (typeof listener !== "function") throw new TypeError("onClose requires a function");
        state2.closeListeners.add(listener);
        if (state2.closedReason !== null) setTimeout(() => flush(state2), 0);
        return () => {
          state2.closeListeners.delete(listener);
        };
      }
    });
  };
  return Object.freeze({
    list: async () => LinkCapabilityEntryListSchema.parse(await call(PLUGIN_CAPABILITY_CHANNELS.REQUEST, { op: "list" })),
    openLink: async (category, request) => LinkTicketSchema.parse(await call(PLUGIN_CAPABILITY_CHANNELS.REQUEST, { ...request ?? {}, op: "openLink", category: String(category) })),
    require: (capability) => Object.freeze({ open: (options) => open(capability, options) }),
    onChange: (listener) => {
      if (typeof listener !== "function") throw new TypeError("capability.onChange requires a function");
      ensureSubscribed();
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    }
  });
}

var ACK_RESULTS = ["accepted", "dropped", "busy"];
function createInputApi(ipc) {
  let handler = null;
  let subscribed = false;
  const call = async (request) => {
    const envelope3 = PluginInputEnvelopeSchema.parse(await ipc.invoke(PLUGIN_INPUT_CHANNELS.REQUEST, request));
    if (!envelope3.ok) throw new Error(envelope3.error);
    return envelope3.value;
  };
  const answer = async (inputId2, run, message) => {
    let result = "dropped";
    let reason3 = run === null ? "not_listening" : void 0;
    if (run !== null) {
      try {
        const value = await run(message);
        const given = typeof value === "object" && value !== null ? value : {};
        result = typeof given.result === "string" && ACK_RESULTS.includes(given.result) ? given.result : "accepted";
        reason3 = typeof given.reason === "string" && /^[a-z0-9_]{1,32}$/.test(given.reason) ? given.reason : void 0;
      } catch {
        result = "dropped";
        reason3 = "handler_error";
      }
    }
    await call({ op: "ack", inputId: inputId2, result, ...reason3 === void 0 ? {} : { reason: reason3 } }).catch(() => void 0);
  };
  const ensureSubscribed = () => {
    if (subscribed) return;
    subscribed = true;
    ipc.on(PLUGIN_INPUT_CHANNELS.EVENT, (_event, payload) => {
      const parsed = PluginInputEventSchema.safeParse(payload);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "input") void answer(message.inputId, handler, message);
      else if (handler !== null) try {
        void Promise.resolve(handler(message)).catch(() => void 0);
      } catch {
      }
    });
  };
  const stateOf = async (request) => PluginInputOwnStateSchema.parse(await call(request));
  return Object.freeze({
    provide: async (onMessage) => {
      if (typeof onMessage !== "function") throw new TypeError("input.provide requires a handler");
      ensureSubscribed();
      const previous = handler;
      handler = onMessage;
      try {
        return await stateOf({ op: "provide" });
      } catch (error) {
        handler = previous;
        throw error;
      }
    },
    stop: async () => {
      handler = null;
      return stateOf({ op: "stop" });
    },
    setSpeaking: async (speaking) => stateOf({ op: "setSpeaking", speaking: speaking === true }),
    state: async () => stateOf({ op: "state" })
  });
}

var AgentOrgRootPathValueSchema = external_exports.object({
  path: external_exports.string().min(1)
});

var PORTAL_MODULES = [
  {
    id: "punch",
    label: "打卡總覽",
    source: "PunchLedger / punchCrud（punches 表）",
    sensitivity: "medium",
    defaultVisible: false
  },
  {
    id: "tasks",
    label: "任務看板",
    source: "TaskService",
    sensitivity: "medium",
    defaultVisible: false
  },
  {
    id: "projects",
    label: "專案與里程碑",
    source: "projectOps / milestoneOps",
    sensitivity: "medium",
    defaultVisible: false
  },
  {
    id: "schedules",
    label: "排程清單",
    source: "ScheduleService",
    sensitivity: "medium",
    defaultVisible: false
  },
  {
    id: "agents",
    label: "AI 團隊/agent 登錄",
    source: "agent_registry（agentRegistryOps）",
    sensitivity: "medium",
    defaultVisible: false
  },
  {
    id: "tokenomics",
    label: "AI 花費儀表板",
    source: "tokenomics domain",
    sensitivity: "medium",
    defaultVisible: false
  },
  {
    id: "conversations",
    label: "對話內容",
    source: "對話讀取模型（v_conversation_messages view）",
    sensitivity: "high",
    defaultVisible: false
  }
];

var ENTITY_NAME_MAX = 200;
var ENTITY_DESCRIPTION_MAX = 262144;
var NAME_CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;
var NON_WHITESPACE_CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
function checkEntityName(value) {
  if (typeof value !== "string") return { ok: false, issue: { field: "name", rule: "invalid_type" } };
  if (value.trim().length === 0) return { ok: false, issue: { field: "name", rule: "required" } };
  if (value.length > ENTITY_NAME_MAX) {
    return { ok: false, issue: { field: "name", rule: "too_long", max: ENTITY_NAME_MAX, actual: value.length } };
  }
  if (NAME_CONTROL_CHAR_RE.test(value)) return { ok: false, issue: { field: "name", rule: "control_char" } };
  return { ok: true, value };
}
function checkEntityDescription(value) {
  if (value === null || value === void 0) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, issue: { field: "description", rule: "invalid_type" } };
  const cleaned = value.replace(NON_WHITESPACE_CONTROL_CHAR_RE, "");
  if (cleaned.length < 1) return { ok: false, issue: { field: "description", rule: "required" } };
  if (cleaned.length > ENTITY_DESCRIPTION_MAX) {
    return { ok: false, issue: { field: "description", rule: "too_long", max: ENTITY_DESCRIPTION_MAX, actual: cleaned.length } };
  }
  return { ok: true, value: cleaned };
}
function addEntityFieldIssue(ctx, issue) {
  ctx.addIssue({ code: external_exports.ZodIssueCode.custom, message: issue.rule, params: { entityFieldIssue: issue } });
}
var EntityNameSchema = external_exports.string().superRefine((value, ctx) => {
  const check = checkEntityName(value);
  if (!check.ok) addEntityFieldIssue(ctx, check.issue);
});
var EntityDescriptionSchema = external_exports.string().transform((value, ctx) => {
  const check = checkEntityDescription(value);
  if (!check.ok) {
    addEntityFieldIssue(ctx, check.issue);
    return external_exports.NEVER;
  }
  return check.value;
});

var PROGRAM_OPERATION_NAMES_V1 = [
  "program.describe",
  "conversation.dispatch",
  "conversation.read",
  "conversation.followUp",
  "data.projects.list",
  "data.projects.get",
  "data.projects.create",
  "data.projects.update",
  "data.projects.delete",
  "data.milestones.list",
  "data.milestones.get",
  "data.milestones.create",
  "data.milestones.update",
  "data.milestones.delete",
  "data.tasks.list",
  "data.tasks.get",
  "data.tasks.create",
  "data.tasks.update",
  "data.tasks.delete"
];
var PROGRAM_SCOPE_NAMES_V1 = [
  "admin",
  "conversation:dispatch",
  "conversation:read",
  "conversation:followup",
  "data:projects:read",
  "data:projects:write",
  "data:milestones:read",
  "data:milestones:write",
  "data:tasks:read",
  "data:tasks:write"
];
var ProgramOperationNameV1Schema = external_exports.enum(PROGRAM_OPERATION_NAMES_V1);
var ProgramScopeV1Schema = external_exports.enum(PROGRAM_SCOPE_NAMES_V1);
var ProgramRequestIdV1Schema = external_exports.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
var PROGRAM_API_MAX_REQUEST_BYTES_V1 = 65536;
var identifier3 = external_exports.string().min(1).max(512);
var nonblank = (max) => external_exports.string().min(1).max(max).refine((value) => value.trim().length > 0);
var pageLimit = external_exports.number().int().min(1).max(100).optional();
var cursor2 = external_exports.string().max(PROGRAM_API_MAX_REQUEST_BYTES_V1).nullable().optional();
var generation2 = external_exports.number().int().nonnegative().optional();
var descriptionInput = EntityDescriptionSchema.nullable().optional();
var entityName = EntityNameSchema;
var ProgramDescribeInputV1Schema = external_exports.object({}).strict();
var ConversationDispatchInputV1Schema = external_exports.object({
  target: external_exports.discriminatedUnion("kind", [
    external_exports.object({ kind: external_exports.literal("project"), projectId: identifier3 }).strict(),
    external_exports.object({ kind: external_exports.literal("task"), taskId: identifier3 }).strict()
  ]),
  provider: external_exports.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  input: nonblank(8e3),
  model: nonblank(256).optional(),
  effort: nonblank(64).optional()
}).strict();
var ConversationReadInputV1Schema = external_exports.object({
  conversationId: identifier3,
  limit: external_exports.number().int().min(1).max(200).optional(),
  startSequence: external_exports.number().int().nonnegative().optional()
}).strict();
var ConversationFollowUpInputV1Schema = external_exports.object({ conversationId: identifier3, text: nonblank(8e3) }).strict();
var projectList = external_exports.object({ limit: pageLimit, cursor: cursor2, snapshotGeneration: generation2, search: external_exports.string().max(PROGRAM_API_MAX_REQUEST_BYTES_V1).nullable().optional() }).strict();
var projectGet = external_exports.object({ projectId: identifier3 }).strict();
var projectCreate = external_exports.object({ name: entityName, description: descriptionInput }).strict();
var projectUpdate = external_exports.object({ projectId: identifier3, expectedAuthoredRevision: external_exports.number().int().nonnegative(), name: entityName.optional(), description: descriptionInput }).strict().refine((value) => value.name !== void 0 || value.description !== void 0);
var projectDelete = external_exports.object({ projectId: identifier3, expectedAuthoredRevision: external_exports.number().int().nonnegative() }).strict();
var milestoneList = external_exports.object({ projectId: identifier3.nullable().optional(), limit: pageLimit, cursor: cursor2, snapshotGeneration: generation2 }).strict();
var milestoneGet = external_exports.object({ milestoneId: identifier3 }).strict();
var milestoneCreate = external_exports.object({ name: entityName, projectId: identifier3.nullable().optional(), description: descriptionInput }).strict();
var milestoneUpdate = external_exports.object({ milestoneId: identifier3, expectedAuthoredRevision: external_exports.number().int().nonnegative(), name: entityName.optional(), description: descriptionInput }).strict().refine((value) => value.name !== void 0 || value.description !== void 0);
var milestoneDelete = external_exports.object({ milestoneId: identifier3, expectedAuthoredRevision: external_exports.number().int().nonnegative() }).strict();
var taskList = external_exports.object({ limit: pageLimit, cursor: cursor2, snapshotGeneration: generation2, search: external_exports.string().max(PROGRAM_API_MAX_REQUEST_BYTES_V1).nullable().optional(), projectId: identifier3.nullable().optional() }).strict();
var taskGet = external_exports.object({ taskId: identifier3 }).strict();
var taskCreate = external_exports.object({ name: entityName, description: descriptionInput, projectId: identifier3.nullable(), milestoneId: identifier3.nullable().optional() }).strict();
var taskUpdate = external_exports.object({ taskId: identifier3, expectedAuthoredRevision: external_exports.number().int().nonnegative(), name: entityName.optional(), description: descriptionInput }).strict().refine((value) => value.name !== void 0 || value.description !== void 0);
var taskDelete = external_exports.object({ taskId: identifier3, expectedAuthoredRevision: external_exports.number().int().nonnegative() }).strict();
var ProgramInputByOperationV1Schema = {
  "program.describe": ProgramDescribeInputV1Schema,
  "conversation.dispatch": ConversationDispatchInputV1Schema,
  "conversation.read": ConversationReadInputV1Schema,
  "conversation.followUp": ConversationFollowUpInputV1Schema,
  "data.projects.list": projectList,
  "data.projects.get": projectGet,
  "data.projects.create": projectCreate,
  "data.projects.update": projectUpdate,
  "data.projects.delete": projectDelete,
  "data.milestones.list": milestoneList,
  "data.milestones.get": milestoneGet,
  "data.milestones.create": milestoneCreate,
  "data.milestones.update": milestoneUpdate,
  "data.milestones.delete": milestoneDelete,
  "data.tasks.list": taskList,
  "data.tasks.get": taskGet,
  "data.tasks.create": taskCreate,
  "data.tasks.update": taskUpdate,
  "data.tasks.delete": taskDelete
};
var ProgramCallV1Schema = external_exports.discriminatedUnion("operation", [
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("program.describe"), input: ProgramInputByOperationV1Schema["program.describe"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("conversation.dispatch"), input: ProgramInputByOperationV1Schema["conversation.dispatch"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("conversation.read"), input: ProgramInputByOperationV1Schema["conversation.read"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("conversation.followUp"), input: ProgramInputByOperationV1Schema["conversation.followUp"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("data.projects.list"), input: ProgramInputByOperationV1Schema["data.projects.list"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("data.projects.get"), input: ProgramInputByOperationV1Schema["data.projects.get"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("data.projects.create"), input: ProgramInputByOperationV1Schema["data.projects.create"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("data.projects.update"), input: ProgramInputByOperationV1Schema["data.projects.update"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("data.projects.delete"), input: ProgramInputByOperationV1Schema["data.projects.delete"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("data.milestones.list"), input: ProgramInputByOperationV1Schema["data.milestones.list"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("data.milestones.get"), input: ProgramInputByOperationV1Schema["data.milestones.get"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("data.milestones.create"), input: ProgramInputByOperationV1Schema["data.milestones.create"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("data.milestones.update"), input: ProgramInputByOperationV1Schema["data.milestones.update"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("data.milestones.delete"), input: ProgramInputByOperationV1Schema["data.milestones.delete"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("data.tasks.list"), input: ProgramInputByOperationV1Schema["data.tasks.list"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("data.tasks.get"), input: ProgramInputByOperationV1Schema["data.tasks.get"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("data.tasks.create"), input: ProgramInputByOperationV1Schema["data.tasks.create"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("data.tasks.update"), input: ProgramInputByOperationV1Schema["data.tasks.update"] }).strict(),
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema, operation: external_exports.literal("data.tasks.delete"), input: ProgramInputByOperationV1Schema["data.tasks.delete"] }).strict()
]);
var DispatchReceiptSchema = external_exports.enum(["accepted", "delivered", "unknown"]);
var ProjectDtoSchema = external_exports.object({ id: identifier3, name: external_exports.string(), description: external_exports.string().nullable(), authoredRevision: external_exports.number().int().nonnegative(), archived: external_exports.boolean(), readOnly: external_exports.boolean().nullable() }).strict();
var MilestoneDtoSchema = external_exports.object({ id: identifier3, name: external_exports.string(), description: external_exports.string().nullable(), projectId: identifier3.nullable(), authoredRevision: external_exports.number().int().nonnegative(), archived: external_exports.boolean(), readOnly: external_exports.boolean().nullable() }).strict();
var TaskDtoSchema = external_exports.object({ id: identifier3, name: external_exports.string(), description: external_exports.string().nullable(), projectId: identifier3.nullable(), milestoneId: identifier3.nullable(), status: nonblank(64), authoredRevision: external_exports.number().int().nonnegative(), deletedAt: external_exports.number().finite().nullable(), readOnly: external_exports.boolean().nullable() }).strict();
var page = (item) => external_exports.object({ items: external_exports.array(item).max(100), nextCursor: external_exports.string().nullable(), snapshotGeneration: external_exports.number().int().nonnegative() }).strict();
var ConversationResultSchema = external_exports.object({ conversationId: identifier3, taskId: identifier3.nullable(), turnId: identifier3, receipt: DispatchReceiptSchema }).strict();
var FollowUpResultSchema = external_exports.object({ turnId: identifier3, receipt: DispatchReceiptSchema }).strict();
var ConversationReadResultSchema = external_exports.object({
  state: external_exports.enum(["ready", "partial"]),
  messages: external_exports.array(external_exports.object({ sequenceNo: external_exports.number().int().nonnegative(), role: external_exports.enum(["user", "assistant"]), text: external_exports.string().max(8e3), truncated: external_exports.boolean() }).strict()).max(200),
  nextSequence: external_exports.number().int().nonnegative().nullable()
}).strict();
var describeRow = external_exports.object({ operation: ProgramOperationNameV1Schema, requiredScope: external_exports.union([ProgramScopeV1Schema, external_exports.literal("none")]), available: external_exports.boolean(), summary: external_exports.string().min(1).max(240) }).strict();
var ProgramResultByOperationV1Schema = {
  "program.describe": external_exports.object({ apiVersion: external_exports.literal(1), operations: external_exports.array(describeRow) }).strict(),
  "conversation.dispatch": ConversationResultSchema,
  "conversation.read": ConversationReadResultSchema,
  "conversation.followUp": FollowUpResultSchema,
  "data.projects.list": page(ProjectDtoSchema),
  "data.projects.get": ProjectDtoSchema,
  "data.projects.create": ProjectDtoSchema,
  "data.projects.update": ProjectDtoSchema,
  "data.projects.delete": ProjectDtoSchema,
  "data.milestones.list": page(MilestoneDtoSchema),
  "data.milestones.get": MilestoneDtoSchema,
  "data.milestones.create": MilestoneDtoSchema,
  "data.milestones.update": MilestoneDtoSchema,
  "data.milestones.delete": MilestoneDtoSchema,
  "data.tasks.list": page(TaskDtoSchema),
  "data.tasks.get": TaskDtoSchema,
  "data.tasks.create": TaskDtoSchema,
  "data.tasks.update": TaskDtoSchema,
  "data.tasks.delete": TaskDtoSchema
};
var PROGRAM_ERROR_CODES_V1 = ["invalid_request", "unsupported_version", "operation_not_supported", "unauthenticated", "forbidden", "not_found", "conflict", "rate_limited", "unavailable", "internal_error"];
var fieldIssue = external_exports.object({ field: external_exports.enum(["apiVersion", "requestId", "operation", "input", "target", "provider", "name", "description", "projectId", "milestoneId", "taskId", "expectedAuthoredRevision", "conversationId", "text", "limit", "cursor", "snapshotGeneration", "startSequence"]), issue: external_exports.enum(["required", "invalid_type", "unknown_key", "invalid_value", "too_small", "too_large", "invalid_format", "empty", "unsupported"]) }).strict();
var ProgramErrorV1Schema = external_exports.object({ code: external_exports.enum(PROGRAM_ERROR_CODES_V1), message: external_exports.string().min(1).max(240), details: external_exports.array(fieldIssue).max(8).optional() }).strict();
var successReply = (operation) => external_exports.object({
  apiVersion: external_exports.literal(1),
  requestId: ProgramRequestIdV1Schema,
  operation: external_exports.literal(operation),
  ok: external_exports.literal(true),
  result: ProgramResultByOperationV1Schema[operation]
}).strict();
var ProgramSuccessReplyV1Schema = external_exports.union([
  successReply("program.describe"),
  successReply("conversation.dispatch"),
  successReply("conversation.read"),
  successReply("conversation.followUp"),
  successReply("data.projects.list"),
  successReply("data.projects.get"),
  successReply("data.projects.create"),
  successReply("data.projects.update"),
  successReply("data.projects.delete"),
  successReply("data.milestones.list"),
  successReply("data.milestones.get"),
  successReply("data.milestones.create"),
  successReply("data.milestones.update"),
  successReply("data.milestones.delete"),
  successReply("data.tasks.list"),
  successReply("data.tasks.get"),
  successReply("data.tasks.create"),
  successReply("data.tasks.update"),
  successReply("data.tasks.delete")
]);
var ProgramReplyV1Schema = external_exports.union([
  ProgramSuccessReplyV1Schema,
  external_exports.object({ apiVersion: external_exports.literal(1), requestId: ProgramRequestIdV1Schema.nullable(), operation: external_exports.string().max(128).nullable(), ok: external_exports.literal(false), error: ProgramErrorV1Schema }).strict()
]);
var ProgramCallerV1Schema = external_exports.object({
  kind: external_exports.enum(["native-api", "plugin", "agent"]),
  principalId: nonblank(256),
  scopes: external_exports.array(ProgramScopeV1Schema).max(32),
  allowedOperations: external_exports.array(ProgramOperationNameV1Schema).max(PROGRAM_OPERATION_NAMES_V1.length).optional(),
  bindings: external_exports.object({ conversationIds: external_exports.array(identifier3).max(1e3).optional(), projectIds: external_exports.array(identifier3).max(1e3).optional(), milestoneIds: external_exports.array(identifier3).max(1e3).optional(), taskIds: external_exports.array(identifier3).max(1e3).optional() }).strict().optional()
}).strict();
var ProgramApiCredentialRefreshRequestV1Schema = external_exports.object({ apiVersion: external_exports.literal(1) }).strict();
var ProgramApiCredentialRefreshResultV1Schema = external_exports.object({ apiVersion: external_exports.literal(1), accessToken: nonblank(4096), expiresAt: external_exports.number().int().nonnegative() }).strict();

var API_SCOPE_READ_ACTION = "read";
var API_STATUS_SCOPE = "read:status";
var API_READ_SCOPES = PORTAL_MODULES.map(
  (m) => `${API_SCOPE_READ_ACTION}:${m.id}`
);
var API_GRANTABLE_SCOPES = [...API_READ_SCOPES, API_STATUS_SCOPE];
var API_PROGRAM_DATA_SCOPES = PROGRAM_SCOPE_NAMES_V1.filter(
  (scope2) => scope2.startsWith("data:")
);

var TEAM_SOURCE_READ_WIRE_VERSION = 1;
var TEAM_SOURCE_READ_LIMITS = {
  maxTeamsPerRoot: 2e3,
  maxAgentsPerTeam: 5e3,
  maxPathsPerRequest: 5e3,
  maxPathLength: 4096,
  maxResponseBytes: 8 * 1024 * 1024
};
var TEAM_SOURCE_READ_FAILURE_REASONS = [
  "native-agent-registry-source-reparse",
  "native-agent-registry-source-root-invalid",
  "native-agent-registry-scan-incomplete",
  "native-agent-registry-source-read-failed",
  "native-agent-registry-source-path-invalid"
];
var TEAM_SOURCE_UNAVAILABLE_REASONS = [
  ...TEAM_SOURCE_READ_FAILURE_REASONS,
  "source-read-timeout",
  "source-cooldown",
  "source-reader-saturated",
  "source-reader-failed",
  "source-output-invalid",
  "source-output-too-large",
  "native-agent-registry-physical-location-unknown"
];
var TEAM_SOURCE_PATH_STATES = ["file", "absent", "unknown"];
var AbsolutePathSchema = external_exports.string().min(1).max(TEAM_SOURCE_READ_LIMITS.maxPathLength);
var TeamSourceReadRootRequestSchema = external_exports.object({
  v: external_exports.literal(TEAM_SOURCE_READ_WIRE_VERSION),
  op: external_exports.literal("readRoot"),
  rootId: external_exports.string().min(1).max(128),
  rootPath: AbsolutePathSchema,
  skillRootPath: AbsolutePathSchema,
  onlyTeamPathParts: external_exports.array(external_exports.string().min(1).max(512)).max(TEAM_SOURCE_READ_LIMITS.maxTeamsPerRoot).nullable()
}).strict();
var TeamSourceCheckFilesRequestSchema = external_exports.object({
  v: external_exports.literal(TEAM_SOURCE_READ_WIRE_VERSION),
  op: external_exports.literal("checkFiles"),
  paths: external_exports.array(AbsolutePathSchema).max(TEAM_SOURCE_READ_LIMITS.maxPathsPerRequest)
}).strict();
var TeamSourceReadRequestSchema = external_exports.discriminatedUnion("op", [
  TeamSourceReadRootRequestSchema,
  TeamSourceCheckFilesRequestSchema
]);
var WireAgentPackageSchema = external_exports.object({
  packageKey: external_exports.string().min(1).max(1024),
  sourceId: external_exports.string().max(256),
  teamId: external_exports.string().max(1024),
  agentName: external_exports.string().max(512),
  formatVersion: external_exports.enum(["v0", "v1", "unknown"]),
  status: external_exports.enum(["ready", "partial", "invalid", "collision"]),
  role: external_exports.enum(["manager", "worker", "unknown"]),
  diagnosticCode: external_exports.enum([
    "missing-anchor",
    "parse-error",
    "identity-conflict",
    "role-conflict",
    "collision",
    "unreadable"
  ]).optional()
}).strict();
var WireAgentTeamVersionSchema = external_exports.object({
  formatVersion: external_exports.enum(["v0", "v1"]),
  status: external_exports.enum(["legacy", "ready", "invalid", "unreadable"]),
  marker: external_exports.enum(["product-yaml", "absent"]),
  diagnosticCode: external_exports.enum([
    "product_yaml_malformed",
    "product_yaml_path_unsafe",
    "product_yaml_unreadable",
    "team_path_unsafe",
    "team_root_unreadable"
  ]).optional()
}).strict();
var WireAgentNodeSchema = external_exports.object({
  id: external_exports.string().max(1024),
  name: external_exports.string().max(512),
  title: external_exports.string().max(4096),
  displayName: external_exports.string().max(1024).nullable(),
  type: external_exports.string().max(64),
  roleInTeam: external_exports.string().max(512).nullable(),
  modelTier: external_exports.string().max(64).nullable(),
  model: external_exports.string().max(256).nullable(),
  trigger: external_exports.string().max(4096).nullable(),
  notFor: external_exports.string().max(4096).nullable(),
  worklogCount: external_exports.number().int().nonnegative().optional(),
  package: WireAgentPackageSchema.optional()
}).strict();
var WireAgentTeamSchema = external_exports.object({
  id: external_exports.string().min(1).max(1024),
  manager: WireAgentNodeSchema.nullable(),
  agents: external_exports.array(WireAgentNodeSchema).max(TEAM_SOURCE_READ_LIMITS.maxAgentsPerTeam),
  teamVersion: WireAgentTeamVersionSchema.optional()
}).strict();
var TeamSourceReadRootResponseSchema = external_exports.discriminatedUnion("status", [
  external_exports.object({
    v: external_exports.literal(TEAM_SOURCE_READ_WIRE_VERSION),
    op: external_exports.literal("readRoot"),
    status: external_exports.literal("ok"),
    teams: external_exports.array(WireAgentTeamSchema).max(TEAM_SOURCE_READ_LIMITS.maxTeamsPerRoot),
    skillNames: external_exports.record(external_exports.string().max(1024), external_exports.string().max(256).nullable())
  }).strict(),
  external_exports.object({
    v: external_exports.literal(TEAM_SOURCE_READ_WIRE_VERSION),
    op: external_exports.literal("readRoot"),
    status: external_exports.literal("missing")
  }).strict(),
  external_exports.object({
    v: external_exports.literal(TEAM_SOURCE_READ_WIRE_VERSION),
    op: external_exports.literal("readRoot"),
    status: external_exports.literal("failed"),
    reason: external_exports.enum(TEAM_SOURCE_READ_FAILURE_REASONS)
  }).strict()
]);
var TeamSourceCheckFilesResponseSchema = external_exports.discriminatedUnion("status", [
  external_exports.object({
    v: external_exports.literal(TEAM_SOURCE_READ_WIRE_VERSION),
    op: external_exports.literal("checkFiles"),
    status: external_exports.literal("ok"),
    states: external_exports.array(external_exports.enum(TEAM_SOURCE_PATH_STATES)).max(TEAM_SOURCE_READ_LIMITS.maxPathsPerRequest)
  }).strict(),
  external_exports.object({
    v: external_exports.literal(TEAM_SOURCE_READ_WIRE_VERSION),
    op: external_exports.literal("checkFiles"),
    status: external_exports.literal("failed"),
    reason: external_exports.enum(TEAM_SOURCE_READ_FAILURE_REASONS)
  }).strict()
]);
var TeamSourceReadResponseSchema = external_exports.union([
  TeamSourceReadRootResponseSchema,
  TeamSourceCheckFilesResponseSchema
]);

var AgentOrgSourceHealthSchema = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("ok"), revision: external_exports.number().int().nonnegative() }).strict(),
  external_exports.object({
    status: external_exports.literal("unavailable"),
    reason: external_exports.enum(TEAM_SOURCE_UNAVAILABLE_REASONS),
    revision: external_exports.number().int().nonnegative()
  }).strict()
]);

var AgentOrgAvatarPickImageSchema = external_exports.object({}).optional();
var AgentOrgAvatarGetImageDataUrlSchema = external_exports.object({
  assetKey: external_exports.string().min(1)
});
var AgentOrgAvatarListCatalogSchema = external_exports.object({}).optional();
var AgentOrgAvatarCatalogPathSchema = external_exports.object({
  catalogPath: external_exports.string().min(1)
});
var AgentOrgAvatarOverrideEntrySchema = external_exports.object({
  type: external_exports.enum(["image", "emoji", "text", "icon"]),
  value: external_exports.string().min(1).max(1024)
}).strict();
var AgentOrgAvatarSetOverrideSchema = external_exports.object({
  scope: external_exports.enum(["groups", "teams", "agents"]),
  key: external_exports.string().min(1).max(256),
  override: AgentOrgAvatarOverrideEntrySchema.nullable()
}).strict();

var AgentOrgExportTeamSchema = external_exports.object({
  teamId: external_exports.string().min(1),
  destDir: external_exports.string().min(1),
  teamName: external_exports.string().min(1).optional(),
  includeWorkRecords: external_exports.boolean().optional()
});

var AgentOrgScanImportSourceSchema = external_exports.object({
  sourcePath: external_exports.string().min(1)
});
var AGENT_ORG_IMPORT_CONFLICT_MODES = ["skip", "replace", "duplicate"];
var AgentOrgImportTeamsSchema = external_exports.object({
  sourcePath: external_exports.string().min(1),
  teamIds: external_exports.array(external_exports.string().min(1)).min(1),
  targetSourceId: external_exports.string().min(1).optional(),
  conflicts: external_exports.record(external_exports.enum(AGENT_ORG_IMPORT_CONFLICT_MODES)).optional()
});

var AgentIntroductionSchema = external_exports.object({
  id: external_exports.string().optional(),
  display_name: external_exports.string().optional(),
  team: external_exports.string().optional(),
  role: external_exports.string().optional(),
  summary: external_exports.string().optional(),
  capabilities: external_exports.array(external_exports.string()).optional(),
  when_to_use: external_exports.string().optional(),
  not_for: external_exports.string().optional(),
  reports_to: external_exports.string().optional(),
  manages: external_exports.array(external_exports.string()).optional(),
  callable_by: external_exports.array(external_exports.string()).optional(),
  inputs: external_exports.string().optional(),
  outputs: external_exports.string().optional(),
  workflows: external_exports.array(external_exports.object({ scenario: external_exports.string(), steps: external_exports.array(external_exports.string()) })).optional(),
  examples: external_exports.array(external_exports.string()).optional(),
  flags: external_exports.array(external_exports.string()).optional(),
  last_updated: external_exports.string().optional()
}).passthrough();
var AgentOrgSaveDraftSchema = external_exports.object({
  teamId: external_exports.string().min(1),
  agentName: external_exports.string().min(1),
  draft: AgentIntroductionSchema,
  baseHash: external_exports.string().optional()
});
var AgentOrgGetDraftSchema = external_exports.object({
  teamId: external_exports.string().min(1),
  agentName: external_exports.string().min(1)
});
var AgentOrgClearDraftSchema = external_exports.object({
  teamId: external_exports.string().min(1),
  agentName: external_exports.string().min(1)
});
var AgentOrgBackupIntroSchema = external_exports.object({
  teamId: external_exports.string().min(1),
  agentName: external_exports.string().min(1)
});

var AgentOrgGetTeamConversationHistorySchema = external_exports.object({
  teamId: external_exports.string().min(1)
});

var SAFE_AGENT_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
var SAFE_TEAM_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
function isSafeTeamKey(value) {
  if (value.includes("%") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const sourceAndTeam = value.split("::");
  if (sourceAndTeam.length > 2) return false;
  const segments = sourceAndTeam.flatMap((path) => path.split("/"));
  return segments.length <= 16 && segments.every((segment) => SAFE_TEAM_SEGMENT.test(segment));
}
var AgentOrgGetVersionedDetailSchema = external_exports.object({
  teamId: external_exports.string().min(1).max(240).refine(isSafeTeamKey, "unsafe team key"),
  agentName: external_exports.string().min(1).max(120).regex(SAFE_AGENT_SEGMENT)
});
var AGENT_VERSION_ERROR_CODE = {
  "partial-v1": "v1_partial",
  "v1-invalid": "v1_invalid",
  "v0-invalid": "v0_invalid",
  missing: "missing",
  unsupported: "unsupported_shape",
  "explicit-version-unknown": "explicit_version_unknown",
  "version-conflict": "version_conflict"
};
var SafeRelativePathSchema = external_exports.string().min(1).max(160).regex(/^[A-Za-z0-9._/-]+$/).refine((value) => !value.startsWith("/") && !value.split("/").includes(".."));
var SafeMessageSchema = external_exports.string().min(1).max(240).regex(/^[A-Za-z0-9 _.,:;()/'-]+$/).refine((value) => !value.includes("\\")).refine((value) => !/(^|[\s:])\//.test(value) && !/(^|[\s:])[A-Za-z]:[\\/]/.test(value));
var DiagnosticCodeSchema = external_exports.enum([
  "missing-file",
  "parse-error",
  "identity-mismatch",
  "role-conflict",
  "explicit-conflict",
  "unsupported-shape"
]);
var BoundedOptionalTextSchema = external_exports.string().min(1).max(240);
var ManagerWorkflowFacingSchema = external_exports.enum(["user", "workers", "internal"]);
var FileEvidenceSchema = external_exports.object({
  state: external_exports.enum(["missing", "present", "invalid"]),
  reason: external_exports.string().max(240).optional()
});
var EvidenceSchema = external_exports.object({
  agentKey: external_exports.object({ teamId: external_exports.string().min(1), agentName: external_exports.string().min(1) }),
  explicitVersion: external_exports.union([external_exports.literal(0), external_exports.literal(1), external_exports.literal("unknown")]).optional(),
  files: external_exports.record(FileEvidenceSchema),
  semantic: external_exports.object({
    agentIdentity: external_exports.string().min(1).optional(),
    teamIdentity: external_exports.string().min(1).optional(),
    role: external_exports.enum(["manager", "worker"]).optional(),
    schemaVersion: external_exports.number().int().optional(),
    requiredCoreValid: external_exports.boolean()
  })
});
var WorkflowStepSchema = external_exports.object({
  id: external_exports.string().min(1),
  label: external_exports.string().min(1),
  action: external_exports.string().min(1).optional(),
  refs: external_exports.array(SafeRelativePathSchema).optional(),
  facing: ManagerWorkflowFacingSchema.optional(),
  output: BoundedOptionalTextSchema.optional()
});
var ManagerViewSchema = external_exports.object({
  identity: external_exports.object({ agent: external_exports.string().min(1), displayName: external_exports.string().optional(), teamId: external_exports.string().min(1) }),
  summary: external_exports.string().optional(),
  capabilities: external_exports.array(external_exports.string()).optional(),
  notFor: BoundedOptionalTextSchema.optional(),
  outputs: external_exports.array(BoundedOptionalTextSchema).max(16).optional(),
  workflow: external_exports.array(WorkflowStepSchema),
  peers: external_exports.array(external_exports.object({ name: BoundedOptionalTextSchema, role: BoundedOptionalTextSchema.optional() })).max(32).optional(),
  routes: external_exports.array(external_exports.object({ scenario: external_exports.string().min(1), steps: external_exports.array(external_exports.string()) })).optional(),
  org: external_exports.object({ schemaVersion: external_exports.literal(1), teamId: external_exports.string().min(1), managerAgent: external_exports.string().min(1) }),
  soul: external_exports.object({ state: external_exports.enum(["present", "missing", "invalid"]) }),
  source: external_exports.object({ sourceId: external_exports.string().optional(), sourceLabel: external_exports.string().optional() }),
  metadata: external_exports.object({ lastUpdated: external_exports.string().optional() }).optional()
});
var V1MetadataSchema = external_exports.object({
  package: external_exports.object({ teamId: external_exports.string().min(1), agentName: external_exports.string().min(1), role: external_exports.enum(["manager", "worker"]) }),
  identity: external_exports.object({ agent: external_exports.string().min(1), teamId: external_exports.string().min(1), role: external_exports.enum(["manager", "worker"]) }),
  workflow: external_exports.object({ state: external_exports.enum(["missing", "present", "invalid"]) }),
  org: external_exports.object({ state: external_exports.enum(["missing", "present", "invalid"]), schemaVersion: external_exports.number().int().optional(), teamId: external_exports.string().optional(), managerAgent: external_exports.string().optional() }),
  soul: external_exports.object({ state: external_exports.enum(["missing", "present", "invalid"]) }),
  source: external_exports.object({ sourceId: external_exports.string().optional(), sourceLabel: external_exports.string().optional() })
});
var AgentVersionedDetailSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("v0"), version: external_exports.literal(0), source: external_exports.string().min(1), legacy: external_exports.record(external_exports.unknown()), evidence: EvidenceSchema }),
  external_exports.object({ kind: external_exports.literal("v1"), version: external_exports.literal(1), source: external_exports.string().min(1), package: V1MetadataSchema.shape.package, view: ManagerViewSchema.nullable(), metadata: V1MetadataSchema, evidence: EvidenceSchema }),
  ...["partial-v1", "v1-invalid", "v0-invalid", "missing", "unsupported", "explicit-version-unknown", "version-conflict"].map(
    (kind) => external_exports.object({
      kind: external_exports.literal(kind),
      version: external_exports.null(),
      code: external_exports.literal(AGENT_VERSION_ERROR_CODE[kind]),
      message: SafeMessageSchema,
      paths: external_exports.array(SafeRelativePathSchema).max(16),
      diagnostics: external_exports.array(DiagnosticCodeSchema).max(16),
      evidence: EvidenceSchema
    })
  )
]);

var AgentRegistrySetEnabledSchema = external_exports.object({
  agentId: external_exports.string().min(1),
  enabled: external_exports.boolean()
});
var AgentRegistrySetStandardizedSchema = external_exports.object({
  agentId: external_exports.string().min(1),
  standardized: external_exports.boolean()
});

var PromptAlertOptionSchema = external_exports.object({
  value: external_exports.string().max(80),
  label: external_exports.string().max(200),
  input: external_exports.string().max(4096).optional()
}).strict();
var PromptAlertPayloadSchema = external_exports.object({
  sessionId: external_exports.string().min(1).max(512),
  taskId: external_exports.string().max(512),
  state: external_exports.enum(["waiting", "error", "resolved", "ready", "onboarding", "login", "early-exit", "timeout"]),
  reason: external_exports.string().max(512),
  options: external_exports.array(PromptAlertOptionSchema).max(6).optional(),
  prompt: external_exports.string().max(1024).optional(),
  source: external_exports.enum(["pty", "monitor"]),
  runtimeId: external_exports.number().int().nonnegative().optional(),
  revision: external_exports.number().int().nonnegative().optional()
}).strict().superRefine((payload, context) => {
  if (payload.source === "pty" && (payload.runtimeId === void 0 || payload.revision === void 0)) {
    context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "PTY prompt events require runtimeId and revision" });
  }
});
var GetPromptSnapshotSchema = external_exports.object({ sessionId: external_exports.string().min(1).max(512) }).strict();

var AppPingRequestSchema = external_exports.object({
  sentAtMs: external_exports.number().int().nonnegative()
}).strict();
var AppPingStallSchema = external_exports.object({
  label: external_exports.string().nullable(),
  spanMs: external_exports.number(),
  endedAtMs: external_exports.number()
}).strict();
var AppPingReplySchema = external_exports.object({
  sentAtMs: external_exports.number(),
  mainReceivedAtMs: external_exports.number(),
  queueMs: external_exports.number(),
  lastStall: AppPingStallSchema.nullable()
}).strict();

var AuthNoArgSchema = external_exports.object({}).strict().optional();
var AuthStatusDtoSchema = external_exports.object({
  loggedIn: external_exports.boolean(),
  email: external_exports.string().nullable(),
  displayName: external_exports.string().nullable(),
  tokenExpired: external_exports.boolean(),
  ephemeral: external_exports.boolean(),
  subscriptionMissing: external_exports.boolean(),
  configured: external_exports.boolean()
}).strict();
var AuthLoginResultDtoSchema = external_exports.object({
  ok: external_exports.boolean(),
  skipped: external_exports.boolean(),
  code: external_exports.string().nullable(),
  message: external_exports.string().nullable(),
  ephemeral: external_exports.boolean(),
  status: AuthStatusDtoSchema
}).strict();

var BOARD_STATUSES = [
  "PREPARATION",
  "WAITING",
  "IN_PROGRESS",
  "PENDING_CONFIRMATION",
  "PENDING",
  "COMPLETED",
  "EXTERNAL",
  "SYSTEM"
];
var BoardStatusSchema = external_exports.enum(BOARD_STATUSES);

var BugReportSupplementalImagePathsSchema = external_exports.array(external_exports.string().min(1).max(32768)).max(10).default([]);
var BugReportSubmitSchema = external_exports.object({
  screenshotDataUrl: external_exports.string().max(32 * 1024 * 1024).optional().default(""),
  cliScreenshotDataUrl: external_exports.string().max(32 * 1024 * 1024).optional().default(""),
  cliScreenshotSkipReason: external_exports.enum(["no-session-context", "cli-not-started", "capture-failed", "timeout"]).optional(),
  logTail: external_exports.string().max(1024 * 1024),
  description: external_exports.string().max(2e4),
  supplementalImagePaths: BugReportSupplementalImagePathsSchema
});
var BugReportUploadToServerSchema = external_exports.object({
  logTail: external_exports.string().max(1024 * 1024),
  description: external_exports.string().max(2e4),
  screenshotDataUrl: external_exports.string().max(32 * 1024 * 1024).optional().default(""),
  cliScreenshotDataUrl: external_exports.string().max(32 * 1024 * 1024).optional().default(""),
  supplementalImagePaths: BugReportSupplementalImagePathsSchema
});

var ClipboardWriteTextSchema = external_exports.object({
  text: external_exports.string()
});

var CONVERSATION_LEDGER_SCAN_PART_SIZE = 64;
var ConversationLedgerScanSourceClaimSchema = external_exports.object({
  scope: external_exports.enum(["source", "maintenance"]),
  sourceKey: external_exports.string().min(1).max(2048),
  rootKey: external_exports.string().min(1).max(1024),
  nativeKey: external_exports.string().min(1).max(1024),
  fileKey: external_exports.string().min(1).max(4096),
  generation: external_exports.string().min(1).max(256),
  bindingIds: external_exports.array(external_exports.string().min(1).max(512)).max(500)
}).strict();
var ConversationLedgerScanTokenModelSliceSchema = external_exports.object({
  id: external_exports.string().min(1).max(256),
  input: external_exports.number().finite(),
  output: external_exports.number().finite(),
  cacheRead: external_exports.number().finite(),
  cacheWrite: external_exports.number().finite().nullable()
}).strict();
var ConversationLedgerScanTokenBreakdownSchema = external_exports.object({
  input: external_exports.number().finite(),
  output: external_exports.number().finite(),
  cacheRead: external_exports.number().finite(),
  cacheWrite: external_exports.number().finite().nullable(),
  costUsd: external_exports.number().finite(),
  turns: external_exports.number().finite(),
  models: external_exports.array(ConversationLedgerScanTokenModelSliceSchema).max(64)
}).strict();
var ConversationLedgerScanWorkflowEditArtifactSchema = external_exports.object({
  tool_use_id: external_exports.string().max(512),
  hunk_index: external_exports.number().int(),
  file_path: external_exports.string().max(4096),
  tool: external_exports.string().max(256),
  op_type: external_exports.string().max(64).nullable(),
  old_start: external_exports.number().int().nullable(),
  lines_added: external_exports.number().int(),
  lines_removed: external_exports.number().int(),
  content_lines: external_exports.number().int().nullable(),
  ts: external_exports.string().max(64).nullable()
}).strict();
var ConversationLedgerScanWorkflowAgentEntrySchema = external_exports.object({
  index: external_exports.number().int(),
  label: external_exports.string().max(512),
  phaseTitle: external_exports.string().max(512),
  phaseIndex: external_exports.number().int(),
  state: external_exports.string().max(64),
  agentId: external_exports.string().max(256).optional(),
  model: external_exports.string().max(256).optional(),
  lastToolName: external_exports.string().max(256).optional(),
  lastToolSummary: external_exports.string().max(2048).optional(),
  promptPreview: external_exports.string().max(4096).optional(),
  resultPreview: external_exports.string().max(4096).optional(),
  tokens: external_exports.number().finite().optional(),
  toolCalls: external_exports.number().finite().optional(),
  durationMs: external_exports.number().finite().optional(),
  startedAt: external_exports.number().finite().optional(),
  editArtifacts: external_exports.array(ConversationLedgerScanWorkflowEditArtifactSchema).max(256).optional(),
  tokenBreakdown: ConversationLedgerScanTokenBreakdownSchema.nullable().optional()
}).strict();
var ConversationLedgerScanWorkflowRunSummarySchema = external_exports.object({
  runId: external_exports.string().min(1).max(256),
  workflowName: external_exports.string().max(512),
  description: external_exports.string().max(2048).optional(),
  status: external_exports.string().max(64),
  live: external_exports.boolean().optional(),
  startTime: external_exports.number().finite().optional(),
  durationMs: external_exports.number().finite().optional(),
  agentCount: external_exports.number().finite().optional(),
  totalTokens: external_exports.number().finite().optional(),
  totalToolCalls: external_exports.number().finite().optional(),
  phases: external_exports.array(external_exports.object({ title: external_exports.string().max(512), detail: external_exports.string().max(2048).optional() }).strict()).max(64),
  agents: external_exports.array(ConversationLedgerScanWorkflowAgentEntrySchema).max(64),
  toolUseId: external_exports.string().max(512).optional()
}).strict();
var ConversationLedgerScanSubagentAssigneeSchema = external_exports.object({
  teamKey: external_exports.string().max(256),
  agentKey: external_exports.string().max(256),
  displayName: external_exports.string().max(512).nullable()
}).strict();
var ConversationLedgerScanSubagentLiveStatSchema = external_exports.object({
  toolUseId: external_exports.string().min(1).max(512),
  anchorToolUseId: external_exports.string().min(1).max(512).optional(),
  assignee: ConversationLedgerScanSubagentAssigneeSchema.optional(),
  totalTokens: external_exports.number().finite().optional(),
  durationMs: external_exports.number().finite().optional(),
  toolCalls: external_exports.number().finite().optional(),
  state: external_exports.enum(["running", "done"]),
  lastTool: external_exports.string().max(256).optional(),
  lastFile: external_exports.string().max(4096).optional()
}).strict();
var ConversationManualZeroLengthCommandSchema = external_exports.object({
  operationId: external_exports.string().min(1).max(256),
  mode: external_exports.enum(["apply", "restore"]),
  scope: external_exports.enum(["zero-length-idle", "api-error-subagent"]).optional(),
  punchIds: external_exports.array(external_exports.string().min(1).max(512)).max(100).optional(),
  dbPath: external_exports.string().min(1).max(4096),
  backupPath: external_exports.string().min(1).max(4096),
  auditPath: external_exports.string().min(1).max(4096).optional()
}).strict().superRefine((command7, context) => {
  if (command7.operationId.startsWith("conversation-reprice:") || command7.operationId.startsWith("conversation-legacy-repair:") || command7.operationId.startsWith("conversation-punch-resettle:")) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "manual operation id uses a reserved automatic namespace", path: ["operationId"] });
  if (command7.mode === "restore" && command7.auditPath === void 0) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "restore requires audit path", path: ["auditPath"] });
  if (command7.mode === "apply" && command7.auditPath !== void 0) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "apply cannot include audit path", path: ["auditPath"] });
  if (command7.mode === "apply" && command7.scope === "api-error-subagent" && (command7.punchIds?.length !== 1 || new Set(command7.punchIds).size !== 1)) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "api-error apply requires one explicit punch id", path: ["punchIds"] });
  if (command7.mode === "restore" && command7.punchIds !== void 0) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "restore uses audit rows, not punch ids", path: ["punchIds"] });
});
var ConversationManualZeroLengthChangeBaseSchema = external_exports.object({
  punchId: external_exports.string().min(1).max(512),
  sessionId: external_exports.string().min(1).max(512),
  startedAtMs: external_exports.number().int().nonnegative(),
  expected: external_exports.object({ endedAtMs: external_exports.number().int().nonnegative(), durationMs: external_exports.number().int().nullable(), detailJson: external_exports.string().max(32768), status: external_exports.enum(["open", "done", "stale", "cancelled"]).optional(), settlementState: external_exports.enum(["unsettled", "settled", "failed", "unknown"]).optional() }).strict(),
  next: external_exports.object({ endedAtMs: external_exports.number().int().nonnegative(), durationMs: external_exports.number().int().nullable(), detailJson: external_exports.string().max(32768), status: external_exports.enum(["open", "done", "stale", "cancelled"]).optional(), settlementState: external_exports.enum(["unsettled", "settled", "failed", "unknown"]).optional() }).strict()
}).strict();
var refineConversationManualZeroLengthChange = (change, context) => {
  for (const side of ["expected", "next"]) {
    if (change[side].status === void 0 !== (change[side].settlementState === void 0)) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "manual state tuple must include both status fields", path: [side] });
  }
  if (change.expected.status !== void 0 && !(change.expected.status === "stale" && change.next.status === "done" && change.expected.settlementState === "settled" && change.next.settlementState === "settled" || change.expected.status === "done" && change.next.status === "stale" && change.expected.settlementState === "settled" && change.next.settlementState === "settled")) {
    context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "settled punch state change must be stale to done or its exact restore", path: ["next", "status"] });
  }
};
var ConversationManualZeroLengthChangeSchema = ConversationManualZeroLengthChangeBaseSchema.superRefine(refineConversationManualZeroLengthChange);
var ConversationWorkOperationSchema = external_exports.object({
  operationId: external_exports.string().min(1).max(256),
  kind: external_exports.enum(["legacy-repair-step", "reprice", "punch-resettle", "manual-zero-length-apply", "manual-zero-length-restore"]),
  settingsRevision: external_exports.number().int().nonnegative().optional(),
  step: external_exports.number().int().min(0).max(3).optional(),
  manualCommand: ConversationManualZeroLengthCommandSchema.optional()
}).strict().superRefine((operation, context) => {
  if (operation.kind === "legacy-repair-step" && operation.step === void 0) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "legacy repair requires step", path: ["step"] });
  if (operation.kind === "punch-resettle" && operation.step !== void 0) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "punch resettle takes no step", path: ["step"] });
  if (operation.kind === "punch-resettle" && operation.settingsRevision !== void 0) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "punch resettle takes no settings revision", path: ["settingsRevision"] });
  if (operation.kind === "reprice" && operation.settingsRevision === void 0) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "reprice requires settings revision", path: ["settingsRevision"] });
  if (operation.kind.startsWith("manual-zero-length-") && operation.manualCommand === void 0) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "manual repair requires command", path: ["manualCommand"] });
  if (!operation.kind.startsWith("manual-zero-length-") && operation.manualCommand !== void 0) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "manual command requires manual operation", path: ["manualCommand"] });
  if (operation.manualCommand !== void 0 && operation.manualCommand.operationId !== operation.operationId) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "command operation id must match envelope", path: ["manualCommand", "operationId"] });
  if (operation.kind === "manual-zero-length-apply" && operation.manualCommand?.mode !== "apply") context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "apply operation requires apply command", path: ["manualCommand", "mode"] });
  if (operation.kind === "manual-zero-length-restore" && operation.manualCommand?.mode !== "restore") context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "restore operation requires restore command", path: ["manualCommand", "mode"] });
});
var ConversationWorkReceiptSchema = external_exports.object({
  operationId: external_exports.string().min(1).max(256),
  status: external_exports.enum(["committed", "no-change", "retryable", "refused", "cancelled"]),
  affectedSessionCount: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  changedPunchCount: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  affectedSessionIds: external_exports.array(external_exports.string().min(1).max(512)).max(500).optional(),
  changedPunchIds: external_exports.array(external_exports.string().min(1).max(512)).max(500).optional(),
  manualChanges: external_exports.array(ConversationManualZeroLengthChangeSchema).max(100).optional(),
  receiptKey: external_exports.string().min(1).max(256),
  errorCode: external_exports.string().min(1).max(128).optional()
}).strict().superRefine((receipt, context) => {
  if (receipt.affectedSessionIds !== void 0 && receipt.affectedSessionIds.length !== receipt.affectedSessionCount) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "session id projection must be complete", path: ["affectedSessionIds"] });
  if (receipt.changedPunchIds !== void 0 && receipt.changedPunchIds.length !== receipt.changedPunchCount) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "punch id projection must be complete", path: ["changedPunchIds"] });
  if (receipt.manualChanges === void 0) return;
  const punchIds = [...new Set(receipt.manualChanges.map((change) => change.punchId))].sort();
  const sessionIds = [...new Set(receipt.manualChanges.map((change) => change.sessionId))].sort();
  if (punchIds.length !== receipt.manualChanges.length || JSON.stringify(punchIds) !== JSON.stringify([...receipt.changedPunchIds ?? []].sort()) || receipt.changedPunchCount !== punchIds.length) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "manual receipt rows must match changed punch ids", path: ["manualChanges"] });
  if (JSON.stringify(sessionIds) !== JSON.stringify([...receipt.affectedSessionIds ?? []].sort()) || receipt.affectedSessionCount !== sessionIds.length) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "manual receipt rows must match affected sessions", path: ["manualChanges"] });
  if (receipt.status === "refused" || receipt.status === "retryable" || receipt.status === "cancelled") context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "only committed manual changes can be receipted", path: ["manualChanges"] });
});
var ConversationLedgerScanDownstreamPushSchema = external_exports.object({
  ownership: external_exports.object({ claim: ConversationLedgerScanSourceClaimSchema, epoch: external_exports.number().int().positive() }).strict().optional(),
  workReceiptKey: external_exports.string().min(1).max(256).optional(),
  sessionId: external_exports.string().min(1).max(512),
  taskId: external_exports.string().min(1).max(512),
  provider: external_exports.enum(["claude", "codex"]),
  punchRowsChanged: external_exports.boolean(),
  workflows: external_exports.array(ConversationLedgerScanWorkflowRunSummarySchema).max(32).optional(),
  subagents: external_exports.array(ConversationLedgerScanSubagentLiveStatSchema).max(CONVERSATION_LEDGER_SCAN_PART_SIZE).optional()
}).strict();

var HookAnswerSchema = external_exports.object({
  toolUseId: external_exports.string().min(1),
  answerText: external_exports.string()
});
var HookCancelSchema = external_exports.object({
  toolUseId: external_exports.string().min(1)
});

var BOOT_CHECKLIST_PHASES = {
  SERVICES_READY: "services-ready",
  UI_ASSETS: "ui-assets",
  LEGACY_DATA: "legacy-data",
  PRIVACY_DATA: "privacy-data",
  ACCOUNT_HANDOFF: "account-handoff",
  MESSAGING_HANDOFF: "messaging-handoff",
  REMOTE_HANDOFF: "remote-handoff",
  CORE_DATA: "core-data",
  STARTUP_SOURCE: "startup-source",
  CORE_ENGINE: "core-engine",
  SETTINGS_READY: "settings-ready",
  SCANNER_ENDPOINT: "scanner-endpoint",
  SCANNER_READY: "scanner-ready",
  SCANNER_ACTIVATED: "scanner-activated",
  CORE_ADMISSION: "core-admission",
  TEAM_FILES: "team-files",
  AI_TEAMS: "ai-teams",
  SESSION_READY: "session-ready",
  HOOKS_READY: "hooks-ready",
  DATA_PREPARED: "prepare-data",
  TEAMS_PREPARED: "prepare-teams",
  ASSISTANTS_LINKED: "link-start",
  UI_RUNTIME_LOADED: "ui-runtime-loaded",
  UI_STYLES_LOADED: "ui-styles-loaded",
  UI_BUNDLE_LOADED: "ui-bundle-loaded",
  UI_LOADED: "ui-loaded",
  TASKS_LOADED: "tasks-loaded",
  TEAMS_LOADED: "teams-loaded",
  SESSIONS_RESTORED: "sessions-restored",
  WORKSPACE_VISIBLE: "workspace-visible"
};
var BOOT_CHECKLIST = [
  { phase: BOOT_CHECKLIST_PHASES.UI_RUNTIME_LOADED, label: "載入介面核心", owner: "renderer" },
  { phase: BOOT_CHECKLIST_PHASES.UI_STYLES_LOADED, label: "載入畫面樣式", owner: "renderer" },
  { phase: BOOT_CHECKLIST_PHASES.UI_BUNDLE_LOADED, label: "載入工作區程式", owner: "renderer" },
  { phase: BOOT_CHECKLIST_PHASES.CORE_ENGINE, label: "啟動資料引擎", owner: "main", sourcePhases: [BOOT_CHECKLIST_PHASES.STARTUP_SOURCE, BOOT_CHECKLIST_PHASES.CORE_ENGINE] },
  { phase: BOOT_CHECKLIST_PHASES.CORE_DATA, label: "準備工作資料", owner: "main", sourcePhases: [BOOT_CHECKLIST_PHASES.CORE_DATA, BOOT_CHECKLIST_PHASES.SETTINGS_READY] },
  { phase: BOOT_CHECKLIST_PHASES.SCANNER_ENDPOINT, label: "連接訊息索引", owner: "main" },
  { phase: BOOT_CHECKLIST_PHASES.SCANNER_READY, label: "配置訊息索引", owner: "main", sourcePhases: ["scanner:realtime:configure", "scanner:background:configure"] },
  { phase: BOOT_CHECKLIST_PHASES.SCANNER_ACTIVATED, label: "啟動訊息索引", owner: "main", sourcePhases: ["scanner:realtime:activate", "scanner:background:activate"] },
  { phase: BOOT_CHECKLIST_PHASES.AI_TEAMS, label: "載入團隊", owner: "main" },
  { phase: BOOT_CHECKLIST_PHASES.SESSION_READY, label: "準備對話", owner: "main" },
  { phase: BOOT_CHECKLIST_PHASES.HOOKS_READY, label: "連接工具", owner: "main" },
  { phase: BOOT_CHECKLIST_PHASES.SERVICES_READY, label: "啟動功能", owner: "main", sourcePhases: [BOOT_CHECKLIST_PHASES.CORE_ADMISSION, BOOT_CHECKLIST_PHASES.SERVICES_READY] },
  { phase: BOOT_CHECKLIST_PHASES.SESSIONS_RESTORED, label: "找回對話", owner: "renderer" },
  { phase: BOOT_CHECKLIST_PHASES.TEAMS_LOADED, label: "顯示團隊", owner: "renderer" }
];

var InputSubmitObservationGetSnapshotsSchema = external_exports.object({
  sessionId: external_exports.string().min(1).max(512)
}).strict();

var Bytes = external_exports.number().finite().int().nonnegative();
var RuntimeMemoryCacheSchema = external_exports.object({
  id: external_exports.string().min(1).max(96),
  label: external_exports.string().min(1).max(96),
  entries: Bytes,
  records: Bytes.nullable(),
  bytes: Bytes.nullable(),
  byteBasis: external_exports.enum(["estimated", "byte-length", "unknown"]),
  sourceBytes: Bytes.nullable()
}).strict().refine((cache) => cache.byteBasis === "unknown" === (cache.bytes === null), "Unknown cache bytes must be null");
var RuntimeMemorySampleSchema = external_exports.object({
  pid: Bytes.positive(),
  threadId: Bytes,
  scope: external_exports.enum(["backend-broker", "backend-runtime"]),
  sampledAtMs: Bytes,
  heapUsedBytes: Bytes,
  heapTotalBytes: Bytes,
  externalBytes: Bytes,
  arrayBufferBytes: Bytes,
  caches: external_exports.array(RuntimeMemoryCacheSchema).max(32)
}).strict();
var RuntimeMemoryMessageSchema = external_exports.object({
  backendMemory: external_exports.literal(1),
  sample: RuntimeMemorySampleSchema
}).strict();

var Integer = external_exports.number().finite().int().nonnegative();
var DiagnosticProcessMemorySchema = external_exports.object({
  pid: Integer,
  type: external_exports.string(),
  name: external_exports.string().nullable(),
  plugins: external_exports.array(external_exports.object({ id: external_exports.string().min(3).max(96), name: external_exports.string().min(1).max(96) }).strict()).max(256).default([]),
  workingSetBytes: Integer.nullable(),
  privateBytes: Integer.nullable(),
  parentPid: Integer.nullable().default(null),
  startedAtMs: Integer.nullable().default(null),
  state: external_exports.enum(["running", "unknown"]).default("unknown"),
  runtimeMemory: external_exports.array(RuntimeMemorySampleSchema).max(16).optional()
}).strict();
var ProcessMemoryCoverageSchema = external_exports.object({
  state: external_exports.enum(["available", "unavailable"]),
  sampledAtMs: Integer.nullable()
}).strict();

var NonNegativeIntegerSchema = external_exports.number().finite().int().nonnegative();
var NullableNonNegativeIntegerSchema = NonNegativeIntegerSchema.nullable();
var MemoryTelemetrySourceSchema = external_exports.enum(["electron.app.getAppMetrics", "os.processSnapshot"]);
var MemoryTelemetryErrorCodeSchema = external_exports.enum(["sample_failed"]);
var MemoryTelemetryErrorSchema = external_exports.object({
  source: MemoryTelemetrySourceSchema,
  code: MemoryTelemetryErrorCodeSchema
}).strict();
var MainThreadpoolSchema = external_exports.object({
  size: external_exports.number().int().min(1).max(1024),
  stackBytesPerThread: NonNegativeIntegerSchema,
  stackAccounting: external_exports.enum(["committed", "reserved"]),
  estimatedStackBytes: NonNegativeIntegerSchema
}).strict().superRefine((pool, ctx) => {
  if (pool.estimatedStackBytes !== pool.size * pool.stackBytesPerThread) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["estimatedStackBytes"],
      message: "estimatedStackBytes must equal size * stackBytesPerThread"
    });
  }
});
var MemoryTelemetryLimitationCodeSchema = external_exports.enum([
  "working_set_is_not_js_heap",
  "working_set_sum_may_double_count_shared_pages",
  "private_bytes_platform_limited",
  "snapshot_is_not_allocation_profile",
  "process_tree_unavailable"
]);
var MemoryDiagnosticsSnapshotSchema = external_exports.object({
  schemaVersion: external_exports.literal(1),
  sampledAtMs: NonNegativeIntegerSchema,
  status: external_exports.enum(["ok", "partial", "error"]),
  units: external_exports.literal("bytes"),
  total: external_exports.object({
    processCount: NonNegativeIntegerSchema,
    workingSetBytes: NullableNonNegativeIntegerSchema,
    privateBytes: NullableNonNegativeIntegerSchema,
    privateBytesKnownProcessCount: NonNegativeIntegerSchema
  }).strict(),
  processes: external_exports.array(DiagnosticProcessMemorySchema),
  processCoverage: ProcessMemoryCoverageSchema.default({ state: "unavailable", sampledAtMs: null }),
  main: external_exports.object({
    pid: NonNegativeIntegerSchema,
    threadpool: MainThreadpoolSchema.nullable().default(null)
  }).strict(),
  sources: external_exports.array(
    external_exports.object({
      source: MemoryTelemetrySourceSchema,
      owner: external_exports.enum(["main", "preload"]),
      nativeUnits: external_exports.enum(["bytes", "kilobytes", "rounded_megabytes"]),
      collection: external_exports.literal("always")
    }).strict()
  ).max(16),
  limitations: external_exports.array(external_exports.object({ code: MemoryTelemetryLimitationCodeSchema }).strict()).max(16),
  errors: external_exports.array(MemoryTelemetryErrorSchema).max(16)
}).strict();

var MAIN_MEMORY_WORKER_ROLES = ["worktime", "subagent_scan", "v1_migration", "native_backend"];
var WorkerMemoryRoleSchema = external_exports.enum(MAIN_MEMORY_WORKER_ROLES);

var MilestonesFindAllSchema = external_exports.object({
  projectLocalId: external_exports.string().nullish(),
  limit: external_exports.number().int().positive().max(100).optional(),
  cursor: external_exports.string().nullish(),
  snapshotGeneration: external_exports.number().int().nonnegative().nullish()
}).optional();
var MilestoneCreateSchema = external_exports.object({
  name: EntityNameSchema,
  projectLocalId: external_exports.string().nullish(),
  platformLocalId: external_exports.string().nullish(),
  syncEnabled: external_exports.boolean().optional(),
  description: EntityDescriptionSchema.nullish(),
  id: external_exports.string().nullish()
});
var MilestoneUpdateSchema = external_exports.object({
  localId: external_exports.string().min(1),
  name: EntityNameSchema.optional(),
  description: EntityDescriptionSchema.nullish(),
  expectedAuthoredRevision: external_exports.number().int().nonnegative().nullish()
});
var MilestoneDeleteSchema = external_exports.object({
  localId: external_exports.string().min(1),
  expectedAuthoredRevision: external_exports.number().int().nonnegative().nullish()
});
var MilestoneFindMembersSchema = external_exports.object({
  milestoneLocalId: external_exports.string().min(1)
});

var ProjectsFindAllSchema = external_exports.object({
  search: external_exports.string().nullish(),
  mineOnly: external_exports.boolean().optional(),
  limit: external_exports.number().int().positive().max(100).optional(),
  cursor: external_exports.string().nullish(),
  snapshotGeneration: external_exports.number().int().nonnegative().nullish()
}).optional();
var ProjectCreateSchema = external_exports.object({
  name: EntityNameSchema,
  platformLocalId: external_exports.string().nullish(),
  syncEnabled: external_exports.boolean().optional(),
  description: EntityDescriptionSchema.nullish(),
  id: external_exports.string().nullish()
});
var ProjectUpdateSchema = external_exports.object({
  localId: external_exports.string().min(1),
  name: EntityNameSchema.optional(),
  description: EntityDescriptionSchema.nullish(),
  expectedAuthoredRevision: external_exports.number().int().nonnegative().nullish()
});
var ProjectDeleteSchema = external_exports.object({
  localId: external_exports.string().min(1),
  expectedAuthoredRevision: external_exports.number().int().nonnegative().nullish()
});
var ProjectsByFolderSchema = external_exports.object({
  folderPath: external_exports.string().min(1),
  limit: external_exports.number().int().positive().max(100).optional(),
  cursor: external_exports.string().nullish(),
  snapshotGeneration: external_exports.number().int().nonnegative().nullish()
});
var ProjectsFoldersByProjectSchema = external_exports.object({
  projectLocalId: external_exports.string().min(1)
});
var ProjectsLinkFolderSchema = external_exports.object({
  projectLocalId: external_exports.string().min(1),
  folderPath: external_exports.string().min(1)
});
var USED_FOLDERS_RECENT_MAX = 50;
var ProjectsListUsedFoldersSchema = external_exports.object({
  recentFolders: external_exports.array(external_exports.string().min(1).max(4096)).max(USED_FOLDERS_RECENT_MAX).optional()
}).optional();
var WEB_TRUSTED_FOLDER_ID_PREFIX = "tuqfolder_";
var WebTrustedFolderTokenItemSchema = external_exports.object({
  folderToken: external_exports.string().min(1),
  folderId: external_exports.string().regex(new RegExp(`^${WEB_TRUSTED_FOLDER_ID_PREFIX}[0-9a-f]{32}$`)),
  label: external_exports.string().min(1),
  source: external_exports.enum(["confirmed", "active", "project"]),
  expiresAt: external_exports.number()
});
var ProjectFolderEntriesSchema = external_exports.object({
  projectLocalId: external_exports.string().min(1).max(512),
  linkedRoot: external_exports.string().min(1).max(4096),
  relativePath: external_exports.string().max(4096).refine((value) => value === "" || value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && !/[\\:\x00]/.test(part)))
}).strict();
var ProjectFolderEntriesResultSchema = external_exports.object({
  entries: external_exports.array(external_exports.object({
    name: external_exports.string(),
    relativePath: external_exports.string(),
    kind: external_exports.enum(["directory", "file", "link", "other"]),
    modifiedAt: external_exports.string().nullable(),
    sizeBytes: external_exports.number().nonnegative().nullable(),
    metadataUnavailable: external_exports.boolean()
  })).max(1e3),
  truncated: external_exports.boolean()
});
var ProjectFolderActionSchema = ProjectFolderEntriesSchema.extend({
  action: external_exports.enum(["open", "reveal", "copyPath"])
}).strict();
var ProjectFolderActionResultSchema = external_exports.object({
  status: external_exports.enum(["handedOff", "copied"])
}).strict();

var CliIdSchema = external_exports.string().min(1).max(64);
function normalizePtyLaunchCommand(value) {
  if (value === null || value === void 0) return value;
  return value.trim().length === 0 ? null : value;
}
var PtySpawnLaunchCommandSchema = external_exports.preprocess(
  (value) => typeof value === "string" ? normalizePtyLaunchCommand(value) : value,
  external_exports.string().nullable().optional()
);
var PtySpawnSchema = external_exports.object({
  id: external_exports.string().min(1),
  cliId: CliIdSchema,
  shell: external_exports.string().optional(),
  cwd: external_exports.string().optional(),
  env: external_exports.record(external_exports.string()).optional(),
  launchCommand: PtySpawnLaunchCommandSchema,
  cols: external_exports.number().int().positive().default(80),
  rows: external_exports.number().int().positive().default(24)
});
var PtyBindingSchema = external_exports.object({
  sessionId: external_exports.string().min(1),
  processId: external_exports.number().int().positive(),
  generation: external_exports.number().int().positive()
});
var PtySpawnResultSchema = external_exports.object({
  replaced: external_exports.boolean(),
  binding: PtyBindingSchema
});
var PtyWriteInputSourceSchema = external_exports.enum(["clipboard"]);
var PtyWriteSchema = external_exports.object({
  id: external_exports.string().min(1),
  data: external_exports.string(),
  inputSource: PtyWriteInputSourceSchema.optional()
});
var PtyLifecycleWriteSchema = external_exports.object({
  binding: PtyBindingSchema,
  data: external_exports.string().min(1)
});
var PtyLaunchSchema = external_exports.object({
  binding: PtyBindingSchema,
  launchCommand: external_exports.string().min(1).refine((value) => value.trim().length > 0, {
    message: "launchCommand must contain a non-whitespace character"
  })
});
var PtyLaunchResultSchema = external_exports.object({
  accepted: external_exports.literal(true),
  duplicate: external_exports.boolean(),
  binding: PtyBindingSchema
});
var PtyResizeSchema = external_exports.object({
  id: external_exports.string().min(1),
  cols: external_exports.number().int().positive(),
  rows: external_exports.number().int().positive()
});
var PtyKillSchema = external_exports.object({
  id: external_exports.string().min(1)
});
var PtyDataSchema = external_exports.object({
  id: external_exports.string().min(1),
  data: external_exports.string()
});
var PtyExitSchema = external_exports.object({
  id: external_exports.string().min(1),
  exitCode: external_exports.number().int()
});
var PtyGetScreenSchema = external_exports.object({
  id: external_exports.string().min(1)
});

var CoreBackendRuntimeHealthSnapshotSchema = external_exports.object({
  state: external_exports.enum([
    "healthy",
    "degraded_database",
    "core_terminated",
    "reconnecting",
    "recovery_failed",
    "permanent_failure",
    "stopping"
  ]),
  reasonCode: external_exports.string().regex(/^[A-Za-z0-9_]{1,96}$/u).nullable(),
  attempt: external_exports.number().int().min(0).max(1),
  maxAttempts: external_exports.number().int().min(0).max(1),
  since: external_exports.number().int().nonnegative()
}).strict();

var SCREEN_DATA_QUERY_NAMES = [
  "schemaMeta",
  "projects",
  "project",
  "projectTasks",
  "projectSessions",
  "agentTeams",
  "agentTeam",
  "teamMembers",
  "tasks",
  "task",
  "taskSessions",
  "sessions",
  "session",
  "sessionConversation",
  "sessionQueue",
  "sessionPunches",
  "sessionChangedFiles",
  "schedules",
  "schedule",
  "scheduleRuns",
  "pmBindings",
  "pmBinding",
  "pmTaskLinks",
  "workspaceSettings",
  "apiKeys",
  "apiKey",
  "chatBindings",
  "chatBinding",
  "chatBindingCodes",
  "punches",
  "punch",
  "changedFiles",
  "spendOverviews",
  "spendOverview",
  "spendSessions",
  "projectionCheckpoints",
  "projectionFailures"
];
var SCREEN_DATA_PAGE_ORDERS = [
  "updated_desc",
  "updated_asc",
  "created_desc",
  "position_asc",
  "sequence_asc"
];
var ScreenPageInputSchema = external_exports.object({
  limit: external_exports.number().int().min(1).max(100).optional(),
  cursor: external_exports.string().min(1).max(512).nullable().optional(),
  order: external_exports.enum(SCREEN_DATA_PAGE_ORDERS).optional()
}).strict();
var ScreenDataQueryRequestSchema = external_exports.object({
  query: external_exports.enum(SCREEN_DATA_QUERY_NAMES),
  id: external_exports.string().min(1).max(512).optional(),
  parentId: external_exports.string().min(1).max(512).optional(),
  page: ScreenPageInputSchema.optional()
}).strict();

var SESSION_RUNTIME_ID_MAX = 512;
var SESSION_RUNTIME_BODY_MAX_BYTES = 2 * 1024 * 1024;
var SESSION_RUNTIME_ATTACHMENT_MAX = 32;
var SESSION_RUNTIME_ATTACHMENT_JSON_MAX_BYTES = 64 * 1024;
var opaqueId = external_exports.string().min(1).max(SESSION_RUNTIME_ID_MAX);
var sessionFp = external_exports.string().regex(/^[0-9a-f]{16}$/);
var sessionRuntimePromptStep = external_exports.object({
  prompt: external_exports.string().max(SESSION_RUNTIME_BODY_MAX_BYTES),
  assigneeSkill: opaqueId.optional()
}).strict();
var SessionRuntimeLaunchOptionsSchema = external_exports.object({
  model: external_exports.string().max(512).nullable(),
  effort: external_exports.string().max(512).nullable(),
  permissionMode: external_exports.enum(["max", "default", "acceptEdits", "plan"]),
  assigneeSkill: opaqueId.nullable(),
  steps: external_exports.array(sessionRuntimePromptStep).max(64),
  origin: external_exports.enum(["user", "schedule", "portal-editor"]),
  subagentPromptSnapshotRef: external_exports.string().regex(/^[0-9a-f]{64}$/).optional()
}).strict();
var SESSION_RUNTIME_MAIN_PROJECT_PATH = Symbol("session-runtime.main-project-path");
var SessionRuntimeAttachmentSchema = external_exports.object({
  ref: opaqueId,
  kind: external_exports.string().min(1).max(64).regex(/^[a-z0-9._-]+$/),
  bytes: external_exports.number().int().nonnegative().optional(),
  mime: external_exports.string().max(128).optional()
}).strict();
var SessionRuntimeDisplayAttachmentSchema = external_exports.object({
  path: external_exports.string().min(1).max(32768),
  kind: external_exports.string().min(1).max(64).regex(/^[a-z0-9._-]+$/),
  displayName: external_exports.string().min(1).max(1024),
  sourceSuffix: external_exports.string().min(1).max(32768).optional(),
  referenceId: external_exports.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
}).strict();
var SessionRuntimeSendNowSchema = external_exports.object({
  sessionId: opaqueId,
  requestId: opaqueId,
  body: external_exports.string(),
  attachments: external_exports.array(SessionRuntimeAttachmentSchema).max(SESSION_RUNTIME_ATTACHMENT_MAX),
  displayText: external_exports.string().max(SESSION_RUNTIME_BODY_MAX_BYTES).optional(),
  displayAttachments: external_exports.array(SessionRuntimeDisplayAttachmentSchema).max(64).optional(),
  lineageId: opaqueId.optional(),
  autoEnter: external_exports.boolean(),
  sessionFp: sessionFp.optional()
}).strict().superRefine((value, ctx) => {
  if (value.attachments.length === 0 && value.body.trim().length === 0) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["body"], message: "body required without attachments" });
});
var SESSION_RUNTIME_MAIN_MATERIALIZED_BODY = Symbol("session-runtime.main-materialized-body");
var SessionRuntimeQueueMutationSchema = external_exports.object({
  sessionId: opaqueId,
  requestId: opaqueId,
  expectedRevision: external_exports.number().int().nonnegative()
}).strict();
var SessionRuntimeQueueEditSchema = SessionRuntimeQueueMutationSchema.extend({ body: external_exports.string().min(1), sessionFp: sessionFp.optional() }).strict();
var SessionRuntimeQueueSnapshotRequestSchema = external_exports.object({ sessionId: opaqueId }).strict();
var SessionRuntimeCommandStateSchema = external_exports.enum(["queued", "dispatching", "original_written", "enter_pending", "submitted", "delivered", "failed", "cancelled", "unknown"]);
var SessionRuntimeWriteCertaintySchema = external_exports.enum(["not_attempted", "not_written", "written", "unknown"]);
var SessionRuntimeQueueItemDtoSchema = external_exports.object({
  requestId: opaqueId,
  revision: external_exports.number().int().nonnegative(),
  state: SessionRuntimeCommandStateSchema,
  writeCertainty: SessionRuntimeWriteCertaintySchema,
  preview: external_exports.string(),
  position: external_exports.number().int().nonnegative(),
  createdAt: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  originalAttempts: external_exports.number().int().nonnegative(),
  enterAttempts: external_exports.number().int().nonnegative(),
  errorCode: external_exports.string().nullable(),
  displayText: external_exports.string().max(SESSION_RUNTIME_BODY_MAX_BYTES).nullable().optional(),
  displayAttachments: external_exports.array(SessionRuntimeDisplayAttachmentSchema).max(64).nullable().optional(),
  lineageId: opaqueId.nullable().optional(),
  sourceProviderSessionId: opaqueId.nullable().optional(),
  sourceProviderTurnId: opaqueId.nullable().optional(),
  sourceGeneration: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  sourceSequenceNo: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  sourceItemKey: external_exports.string().min(1).max(4096).nullable().optional(),
  sourceByteStart: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional()
}).strict();
var SessionRuntimeQueueSnapshotDtoSchema = external_exports.object({
  sessionId: opaqueId,
  revision: external_exports.number().int().nonnegative(),
  items: external_exports.array(SessionRuntimeQueueItemDtoSchema)
}).strict();

var CHAT_PLATFORMS_WIRE = ["telegram", "discord", "line"];
var SessionPermissionModeSchema = external_exports.enum(["default", "acceptEdits", "plan", "max"]);
var SafeGroupingLabelSchema = external_exports.string().min(1).max(64).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
var SafeQuotaPublicScopeSchema = external_exports.string().min(1).max(128).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
var SessionAiGroupingSchema = external_exports.object({
  providerId: external_exports.enum(["antigravity", "claude", "codex"]).nullable(),
  quotaPublicScopeId: SafeQuotaPublicScopeSchema.nullable(),
  modelId: SafeGroupingLabelSchema.nullable(),
  modelLabel: SafeGroupingLabelSchema.nullable()
});
var SessionInfoSchema = external_exports.object({
  sessionId: external_exports.string().min(1).max(512),
  taskId: external_exports.string().min(1).max(512),
  taskName: external_exports.string().max(1024),
  projectPath: external_exports.string().max(32768),
  projectLocalId: external_exports.string().max(160).nullable().optional(),
  projectName: external_exports.string().max(1024).nullable().optional(),
  milestoneId: external_exports.string().max(512).nullable(),
  tool: external_exports.string().min(1).max(64),
  turnMode: external_exports.enum(["pty-text", "structured"]).optional(),
  launchCommand: external_exports.string().max(32768).nullable(),
  permissionMode: SessionPermissionModeSchema.nullable().optional(),
  model: external_exports.string().max(512).nullable().optional(),
  effort: external_exports.string().max(512).nullable().optional(),
  aiGrouping: SessionAiGroupingSchema,
  conversationRef: external_exports.object({ providerId: external_exports.enum(["antigravity", "claude", "codex"]), externalId: external_exports.string().max(512).nullable(), openedAtMs: external_exports.number().nonnegative() }).strict().nullable().optional(),
  pathAutofixed: external_exports.boolean().optional(),
  adoptedFolderLatest: external_exports.boolean().optional(),
  teamKey: external_exports.string().max(512).optional(),
  skillName: external_exports.string().max(512).optional(),
  taskOrigin: external_exports.string().max(128).optional(),
  taskTitleLocked: external_exports.boolean().optional()
}).strict();
var ConversationStartUserTaskSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("existing"), taskId: external_exports.string().min(1).max(512) }).strict(),
  external_exports.object({
    kind: external_exports.literal("auto"),
    name: external_exports.string().max(200).optional(),
    description: external_exports.string().max(262144).nullable(),
    projectId: external_exports.string().min(1).max(160).nullable().optional(),
    folderPath: external_exports.string().max(32768).nullable().optional(),
    folderPathSnapshot: external_exports.string().max(32768).nullable().optional(),
    teamKey: external_exports.string().max(512).nullable().optional()
  }).strict()
]);
var ConversationStartInputContentSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("text"), body: external_exports.string().max(SESSION_RUNTIME_BODY_MAX_BYTES) }).strict(),
  external_exports.object({
    kind: external_exports.literal("selection"),
    body: external_exports.string().max(SESSION_RUNTIME_BODY_MAX_BYTES),
    attachments: external_exports.array(external_exports.object({
      path: external_exports.string().min(1).max(32768),
      kind: external_exports.string().min(1).max(64),
      displayName: external_exports.string().max(1024),
      sourceSuffix: external_exports.string().max(32768).optional(),
      referenceId: external_exports.number().int().positive().optional()
    }).strict()).max(32)
  }).strict(),
  external_exports.object({
    kind: external_exports.literal("refs"),
    body: external_exports.string().max(SESSION_RUNTIME_BODY_MAX_BYTES),
    attachments: external_exports.array(SessionRuntimeAttachmentSchema).max(32),
    sessionFp: external_exports.string().regex(/^[0-9a-f]{16}$/).optional(),
    materializedBody: external_exports.string().max(SESSION_RUNTIME_BODY_MAX_BYTES).optional()
  }).strict()
]);
var SessionStartConversationSchema = external_exports.object({
  target: external_exports.object({
    kind: external_exports.literal("pty"),
    open: external_exports.object({
      origin: external_exports.literal("user"),
      provider: external_exports.string().min(1).max(64),
      projectId: external_exports.string().min(1).max(160).nullable(),
      projectPath: external_exports.string().max(32768).nullable(),
      task: ConversationStartUserTaskSchema,
      teamMeta: external_exports.object({
        teamKey: external_exports.string().min(1).max(512),
        skillName: external_exports.string().max(512).optional(),
        skipSentinel: external_exports.boolean().optional()
      }).strict().optional(),
      resume: external_exports.discriminatedUnion("kind", [
        external_exports.object({ kind: external_exports.literal("none") }).strict(),
        external_exports.object({ kind: external_exports.literal("auto") }).strict(),
        external_exports.object({ kind: external_exports.literal("explicit"), providerSessionId: external_exports.string().max(512).nullable() }).strict()
      ]),
      launch: external_exports.object({
        model: external_exports.string().max(512).nullable(),
        effort: external_exports.string().max(512).nullable(),
        permissionMode: SessionPermissionModeSchema,
        launchOrigin: external_exports.literal("portal-editor").optional(),
        dispatchContext: external_exports.object({ projectId: external_exports.string().trim().min(1).max(160), folderPath: external_exports.string().trim().min(1).max(4096), userSelected: external_exports.literal(true) }).strict().optional()
      }).strict()
    }).strict()
  }).strict(),
  initialInput: external_exports.object({
    kind: external_exports.literal("pty"),
    origin: external_exports.enum(["user", "web"]),
    content: ConversationStartInputContentSchema,
    requestId: external_exports.string().min(1).max(512).optional(),
    autoEnter: external_exports.boolean().optional()
  }).strict().optional()
}).strict();
var SESSION_REPLY_STATUS_PER_SESSION = 4;
var SESSION_REPLY_STATUS_SESSIONS = 256;
var SessionReplyStatusSchema = external_exports.object({
  sessionId: external_exports.string().min(1).max(512),
  requestId: external_exports.string().min(1).max(512),
  providerTurnId: external_exports.string().min(1).max(512).optional(),
  status: external_exports.enum(["interrupted", "failed"])
}).strict();
var SessionEventEnvelopeSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("snapshot"), epoch: external_exports.string().min(1).max(64), revision: external_exports.number().int().nonnegative(), sessions: external_exports.array(external_exports.object({ sessionId: external_exports.string().min(1).max(512), mode: external_exports.enum(["rpc", "pty", "none"]), status: external_exports.string().min(1).max(64), runState: external_exports.string().min(1).max(64), provider: external_exports.string().max(64).nullable(), title: external_exports.string().max(1024).nullable(), taskId: external_exports.string().max(512).nullable(), sessionInfo: SessionInfoSchema.nullable() }).strict()), replyStatuses: external_exports.array(SessionReplyStatusSchema).max(SESSION_REPLY_STATUS_PER_SESSION * SESSION_REPLY_STATUS_SESSIONS) }).strict(),
  external_exports.object({ kind: external_exports.literal("activeChanged"), epoch: external_exports.string().min(1).max(64), revision: external_exports.number().int().nonnegative(), sessionId: external_exports.string().min(1).max(512), mode: external_exports.enum(["rpc", "pty", "none"]), active: external_exports.boolean(), summary: external_exports.object({ status: external_exports.string().min(1).max(64), runState: external_exports.string().min(1).max(64), provider: external_exports.string().max(64).nullable(), title: external_exports.string().max(1024).nullable(), taskId: external_exports.string().max(512).nullable() }).strict().nullable(), sessionInfo: SessionInfoSchema.nullable() }).strict(),
  external_exports.object({ kind: external_exports.literal("inputAccepted"), epoch: external_exports.string().min(1).max(64), revision: external_exports.number().int().nonnegative(), sessionId: external_exports.string().min(1).max(512), requestId: external_exports.string().min(1).max(512) }).strict(),
  external_exports.object({ kind: external_exports.literal("interrupted"), epoch: external_exports.string().min(1).max(64), revision: external_exports.number().int().nonnegative(), sessionId: external_exports.string().min(1).max(512), requestId: external_exports.string().min(1).max(512), providerTurnId: external_exports.string().min(1).max(512).optional() }).strict(),
  external_exports.object({ kind: external_exports.literal("failed"), epoch: external_exports.string().min(1).max(64), revision: external_exports.number().int().nonnegative(), sessionId: external_exports.string().min(1).max(512), requestId: external_exports.string().min(1).max(512), providerTurnId: external_exports.string().min(1).max(512).optional(), code: external_exports.string().min(1).max(128), retryable: external_exports.boolean(), outcome: external_exports.enum(["failed", "unknown"]) }).strict(),
  external_exports.object({ kind: external_exports.literal("contentChanged"), epoch: external_exports.string().min(1).max(64), revision: external_exports.number().int().nonnegative(), sessionId: external_exports.string().min(1).max(512), providerSessionId: external_exports.string().min(1).max(512).nullable().optional(), sourceGeneration: external_exports.number().int().nonnegative(), totalCount: external_exports.number().int().nonnegative(), messages: external_exports.array(external_exports.object({ sequenceNo: external_exports.number().int().nonnegative(), role: external_exports.enum(["user", "assistant"]), text: external_exports.string().max(8192), truncated: external_exports.boolean(), source: external_exports.enum(["typed", "command", "tool_result", "meta", "interrupt", "notify"]).optional(), itemKey: external_exports.string().min(1).max(2048).optional(), byteStart: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict()).max(8) }).strict(),
  external_exports.object({ kind: external_exports.literal("sessionClosed"), epoch: external_exports.string().min(1).max(64), revision: external_exports.number().int().nonnegative(), sessionId: external_exports.string().min(1).max(512) }).strict()
]);
var WindowScanReportSchema = external_exports.object({
  focusedSessionId: external_exports.string().min(1).max(512).nullable(),
  sessionIds: external_exports.array(external_exports.string().min(1).max(512)).max(2e3)
}).strict();
var ConversationRefSchema = external_exports.object({
  cliId: external_exports.enum(["claude", "codex"]),
  conversationId: external_exports.string().uuid()
});
var SessionTurnModeSchema = external_exports.enum(["pty-text", "structured"]);
var SessionTeamMetaSchema = external_exports.object({
  teamKey: external_exports.string().min(1),
  skillName: external_exports.string().optional(),
  model: external_exports.string().optional(),
  effort: external_exports.string().optional(),
  skipSentinel: external_exports.boolean().optional(),
  chatOpsPlatform: external_exports.enum(CHAT_PLATFORMS_WIRE).optional()
});
var SessionOpenSchema = external_exports.object({
  taskId: external_exports.string().min(1),
  projectPath: external_exports.string().optional(),
  permissionMode: SessionPermissionModeSchema,
  milestoneId: external_exports.string().nullish(),
  tool: external_exports.string().optional(),
  customCommand: external_exports.string().nullish(),
  forceNewSession: external_exports.boolean().optional(),
  resumeExternalId: external_exports.string().optional(),
  historyResume: external_exports.boolean().optional(),
  allowDuplicateForTask: external_exports.boolean().optional(),
  launchOrigin: external_exports.literal("portal-editor").optional(),
  teamMeta: SessionTeamMetaSchema.optional(),
  monitorEnabled: external_exports.boolean().optional(),
  teamAutoSend: external_exports.boolean().optional(),
  model: external_exports.string().min(1).nullable(),
  effort: external_exports.string().min(1).nullable(),
  verifiedProjectPaths: external_exports.array(external_exports.string().min(1)).optional(),
  dispatchContext: external_exports.object({ projectId: external_exports.string().trim().min(1).max(160), folderPath: external_exports.string().trim().min(1).max(4096), userSelected: external_exports.literal(true) }).strict().optional()
});
var SessionCloseSchema = external_exports.object({
  sessionId: external_exports.string().min(1)
});
var SessionListSchema = external_exports.object({
  sessionId: external_exports.string().min(1)
});
var SessionReopenPersistedSchema = external_exports.object({
  sessionId: external_exports.string().min(1).max(512)
}).strict();
var SessionPersistedInventoryItemSchema = external_exports.object({
  sessionId: external_exports.string().min(1).max(512),
  provider: external_exports.string().max(64).nullable(),
  title: external_exports.string().max(1024).nullable(),
  taskId: external_exports.string().max(512).nullable(),
  projectPath: external_exports.string().max(4096).nullable(),
  status: external_exports.string().min(1).max(64),
  runState: external_exports.string().min(1).max(64),
  closed: external_exports.boolean(),
  createdAt: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reopenable: external_exports.boolean(),
  identityRecoveryRequired: external_exports.boolean()
}).strict();
var SessionPersistedInventoryResponseSchema = external_exports.array(SessionPersistedInventoryItemSchema);
var SessionListFolderSchema = external_exports.object({
  folderPath: external_exports.string(),
  cliId: external_exports.enum(["antigravity", "claude", "codex"]).optional().default("claude")
});
var SessionRenameSchema = external_exports.object({
  sessionId: external_exports.string().min(1),
  customTitle: external_exports.string().min(1)
});
var SessionGetConversationSchema = external_exports.object({
  sessionId: external_exports.string().min(1)
});
var SessionSetProjectSchema = external_exports.object({
  sessionId: external_exports.string().min(1),
  projectPath: external_exports.string(),
  tool: external_exports.string().optional(),
  preserveSession: external_exports.boolean().optional(),
  model: external_exports.string().optional(),
  effort: external_exports.string().optional(),
  forceNewSession: external_exports.boolean().optional(),
  permissionMode: SessionPermissionModeSchema.optional()
});
var SessionListSkillsSchema = external_exports.object({
  sessionId: external_exports.string().min(1)
});
var SessionArmCreateTeamPreviewSchema = external_exports.object({
  sessionId: external_exports.string().min(1),
  groupId: external_exports.string().min(1)
});
var SessionConsumeCreateTeamPreviewSchema = external_exports.object({
  taskId: external_exports.string().min(1)
});
var SessionRuntimeCommandStateSchema2 = external_exports.enum(["queued", "dispatching", "original_written", "enter_pending", "submitted", "delivered", "failed", "cancelled", "unknown"]);
var SessionRuntimeSendResultSchema = external_exports.discriminatedUnion("outcome", [
  external_exports.object({ outcome: external_exports.literal("accepted"), requestId: external_exports.string().min(1).max(512), state: SessionRuntimeCommandStateSchema2, replay: external_exports.boolean() }).strict(),
  external_exports.object({ outcome: external_exports.literal("delivered"), requestId: external_exports.string().min(1).max(512) }).strict(),
  external_exports.object({ outcome: external_exports.literal("unknown"), requestId: external_exports.string().min(1).max(512), reason: external_exports.string().min(1).max(256) }).strict()
]);
var SessionRuntimeCommandSettledSchema = external_exports.discriminatedUnion("settled", [
  external_exports.object({ settled: external_exports.literal(true), state: SessionRuntimeCommandStateSchema2 }).strict(),
  external_exports.object({ settled: external_exports.literal(false), reason: external_exports.enum(["stalled", "response_deadline", "record_not_found"]) }).strict()
]);
var SessionStartInputReceiptSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("sent"), requestId: external_exports.string().min(1).max(512), send: SessionRuntimeSendResultSchema, settled: SessionRuntimeCommandSettledSchema.nullable() }).strict(),
  external_exports.object({ kind: external_exports.literal("refused"), requestId: external_exports.string().min(1).max(512), code: external_exports.string().min(1).max(128), retryable: external_exports.boolean(), message: external_exports.string().max(2048).optional() }).strict()
]);
var SessionStartConversationResultSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ ok: external_exports.literal(true), target: external_exports.object({ kind: external_exports.literal("pty") }).strict(), sessionId: external_exports.string().min(1).max(512), taskId: external_exports.string().min(1).max(512), execution: external_exports.enum(["created", "attached", "resumed"]), opened: external_exports.object({ ok: external_exports.literal(true), sessionId: external_exports.string().min(1).max(512), taskId: external_exports.string().min(1).max(512), execution: external_exports.enum(["created", "attached", "resumed"]), mintedTaskId: external_exports.string().max(512).nullable(), session: SessionInfoSchema }).strict(), input: SessionStartInputReceiptSchema.optional() }).strict(),
  external_exports.object({ ok: external_exports.literal(false), stage: external_exports.enum(["open", "first_input"]), code: external_exports.string().min(1).max(128), retryable: external_exports.boolean(), message: external_exports.string().max(2048).optional(), sessionId: external_exports.string().min(1).max(512).optional(), causeCode: external_exports.string().max(128).optional(), input: SessionStartInputReceiptSchema.optional() }).strict()
]).superRefine((result, context) => {
  if (!result.ok) return;
  if (result.opened.sessionId !== result.sessionId || result.opened.session.sessionId !== result.sessionId) {
    context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["sessionId"], message: "session identity mismatch" });
  }
  if (result.opened.taskId !== result.taskId || result.opened.session.taskId !== result.taskId) {
    context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["taskId"], message: "task identity mismatch" });
  }
});
var SessionConversationIdSchema = external_exports.object({ sessionId: external_exports.string().min(1) });
var SessionGetTokenUsageSchema = external_exports.object({
  sessionId: external_exports.string().min(1),
  startedAt: external_exports.string().nullish(),
  endedAt: external_exports.string().nullish()
});
var SessionGetSubagentConversationSchema = SessionConversationIdSchema.extend({
  toolUseId: external_exports.string().min(1),
  agentId: external_exports.string().min(1).optional()
});
var SessionGetSubagentStatsSchema = SessionConversationIdSchema.extend({
  toolUseId: external_exports.string().min(1),
  agentId: external_exports.string().min(1).optional()
});
var SessionGetWorkflowAgentConversationSchema = SessionConversationIdSchema.extend({
  runId: external_exports.string().min(1),
  agentId: external_exports.string().min(1)
});
var SessionGetConversationWindowSchema = SessionConversationIdSchema.extend({
  knownVersion: external_exports.string().max(128).optional()
});
var SessionGetSegmentMessagesSchema = SessionConversationIdSchema.extend({
  startSeq: external_exports.number().int().min(0),
  endSeq: external_exports.number().int().min(0)
});
var SessionGetRawLinesSchema = SessionConversationIdSchema.extend({
  startSeq: external_exports.number().int().min(0),
  endSeq: external_exports.number().int().min(0)
});
var SessionSearchConversationSchema = SessionConversationIdSchema.extend({
  query: external_exports.string().min(1).max(200),
  cursor: external_exports.number().int().min(0).nullish(),
  limit: external_exports.number().int().min(1).max(500).optional()
});

var canonicalProjectId = external_exports.string().refine((value) => /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n);
var projectTaskSummaryCount = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var projectTaskStatsName = external_exports.string().min(1).max(512);
var ProjectTaskSummaryInputSchema = external_exports.object({
  projectId: canonicalProjectId
}).strict();
var ProjectTaskStatsSchema = external_exports.object({
  projectId: canonicalProjectId.nullable(),
  name: projectTaskStatsName.nullable(),
  total: projectTaskSummaryCount,
  completed: projectTaskSummaryCount,
  inProgress: projectTaskSummaryCount,
  overdue: projectTaskSummaryCount,
  punchOngoing: projectTaskSummaryCount,
  milestones: projectTaskSummaryCount,
  folders: projectTaskSummaryCount,
  statuses: external_exports.array(external_exports.object({ status: external_exports.string().min(1).max(256), count: projectTaskSummaryCount }).strict()).max(100)
}).strict();
var ProjectTaskSummarySchema = ProjectTaskStatsSchema.extend({ projectId: canonicalProjectId }).strict();
var ProjectTaskStatsItemSchema = ProjectTaskSummarySchema.extend({ name: projectTaskStatsName }).strict();
var ProjectTaskStatsUncategorizedSchema = ProjectTaskStatsSchema.extend({ projectId: external_exports.null(), name: external_exports.null() }).strict();
var TasksProjectStatsPayloadSchema = external_exports.object({
  limit: external_exports.number().int().min(1).max(100).optional(),
  cursor: external_exports.string().min(1).max(512).nullish(),
  snapshotGeneration: external_exports.number().int().nonnegative().nullish()
}).strict();
var TasksFindAllSchema = external_exports.object({
  search: external_exports.string().nullish(),
  statuses: external_exports.union([external_exports.string(), external_exports.array(external_exports.string())]).nullish(),
  limit: external_exports.number().nullish(),
  offset: external_exports.number().nullish(),
  cursor: external_exports.string().nullish(),
  snapshotGeneration: external_exports.number().int().nonnegative().nullish(),
  projectId: external_exports.string().nullish(),
  session: external_exports.discriminatedUnion("kind", [
    external_exports.object({ kind: external_exports.literal("teamuq"), sessionId: external_exports.string().min(1) }),
    external_exports.object({ kind: external_exports.literal("provider"), provider: external_exports.string().min(1), sessionId: external_exports.string().min(1), taskId: external_exports.string().min(1).optional() })
  ]).optional()
});
var TasksFindBySessionIdSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("teamuq"), sessionId: external_exports.string().min(1) }),
  external_exports.object({ kind: external_exports.literal("provider"), provider: external_exports.string().min(1), sessionId: external_exports.string().min(1), taskId: external_exports.string().min(1).optional() })
]);
var TasksListSessionIdsByTaskSchema = external_exports.object({
  taskId: external_exports.string().min(1)
});
var TasksUpdateSchema = external_exports.object({
  taskId: external_exports.string().min(1),
  status: external_exports.string().min(1),
  name: EntityNameSchema.optional(),
  description: EntityDescriptionSchema.nullish(),
  projectLocalId: external_exports.string().nullish(),
  milestoneLocalId: external_exports.string().nullish(),
  cli: external_exports.string().nullish(),
  folderPathSnapshot: external_exports.string().nullish(),
  teamKey: external_exports.string().nullish(),
  assigneeSelf: external_exports.boolean().optional(),
  plannedStartDate: external_exports.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable().optional(),
  plannedEndDate: external_exports.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable().optional(),
  version: external_exports.number().nullish(),
  expectedAuthoredRevision: external_exports.number().int().nonnegative().nullish()
});
var TasksRenameSchema = external_exports.object({
  taskId: external_exports.string().min(1),
  name: EntityNameSchema,
  expectedAuthoredRevision: external_exports.number().int().nonnegative().nullish()
});
var TasksAssignTeamSchema = external_exports.object({
  taskId: external_exports.string().min(1),
  teamKey: external_exports.string().min(1).nullable(),
  expectedAuthoredRevision: external_exports.number().int().nonnegative().nullish(),
  version: external_exports.number().int().nonnegative().nullish()
});
var TasksListAssignableTeamsSchema = external_exports.object({}).strict();
var TasksDeleteSchema = external_exports.object({
  taskId: external_exports.string().min(1),
  expectedAuthoredRevision: external_exports.number().int().nonnegative().nullish()
});
var TasksCreateSchema = external_exports.object({
  name: EntityNameSchema,
  milestoneLocalId: external_exports.string().nullish(),
  projectLocalId: external_exports.string().nullish(),
  folderPath: external_exports.string().nullish(),
  status: external_exports.string().min(1).default("PENDING"),
  description: EntityDescriptionSchema.nullish(),
  assigneeSelf: external_exports.boolean().optional(),
  origin: external_exports.string().refine((origin2) => origin2 !== "import", { message: "origin_not_allowed" }).nullish(),
  cli: external_exports.string().nullish(),
  folderPathSnapshot: external_exports.string().nullish(),
  teamKey: external_exports.string().nullish(),
  titleSource: external_exports.enum(["auto", "manual"]).optional()
});

var SystemOpenExternalSchema = external_exports.object({ url: external_exports.string().url() });
var SystemOpenFolderSchema = external_exports.object({
  path: external_exports.string().min(1),
  cwd: external_exports.string().optional()
});
var SystemOpenPathSchema = external_exports.object({
  path: external_exports.string().min(1),
  cwd: external_exports.string().optional()
});
var SystemSetAutoLaunchSchema = external_exports.object({ enabled: external_exports.boolean() });

var TelemetryBumpSchema = external_exports.object({
  code: external_exports.string().min(1)
});

var UNSUPPORTED_REASON_RECOVERABLE = {
  "not-packaged": false,
  "dev-server": false,
  "disabled-by-env": false,
  "platform-not-allowed": false,
  "package-format-not-supported": false,
  "package-not-published": true
};
var ALL_UNSUPPORTED_REASONS = Object.keys(
  UNSUPPORTED_REASON_RECOVERABLE
);
var UpdaterOpenDownloadedFileLocationSchema = external_exports.object({
  path: external_exports.string().min(1)
});

var safeId = external_exports.string().min(1).max(512);
var nullableSafeId = safeId.nullable();
var now = external_exports.number().int().nonnegative().safe().optional();
var NativeCreateProjectSchema = external_exports.object({
  suffix: safeId,
  name: EntityNameSchema,
  description: EntityDescriptionSchema.nullable().optional(),
  now
});
var NativeCreateTaskSchema = external_exports.object({
  suffix: safeId,
  projectId: nullableSafeId,
  milestoneId: nullableSafeId.optional(),
  name: EntityNameSchema,
  description: EntityDescriptionSchema.nullable().optional(),
  now
});
var NativeCreatePendingSessionSchema = external_exports.object({
  suffix: safeId,
  taskId: nullableSafeId,
  projectId: nullableSafeId,
  title: external_exports.string().max(512).nullable().optional(),
  provider: external_exports.string().min(1).max(128).nullable().optional(),
  providerSessionId: safeId.nullable().optional(),
  runtimeSessionId: safeId.nullable().optional(),
  sourceRef: safeId.nullable().optional(),
  now
});
var NativeStartMonitorSchema = external_exports.object({
  taskId: safeId,
  sessionId: safeId,
  provider: external_exports.string().min(1).max(128),
  providerSessionId: safeId,
  runtimeSessionId: safeId.nullable(),
  projectPath: external_exports.string().min(1).max(4096),
  sourceRef: safeId.nullable(),
  sinceMs: external_exports.number().int().nonnegative().safe(),
  monitoredSessionIds: external_exports.array(safeId).min(1).max(128),
  bindingRevision: external_exports.number().int().nonnegative().safe()
});
var NativeStopMonitorSchema = external_exports.object({ sessionId: safeId });
var NativeQueryTaskSchema = external_exports.object({
  ref: external_exports.union([
    external_exports.object({ kind: external_exports.literal("id"), id: safeId }),
    external_exports.object({ kind: external_exports.literal("sourceKey"), sourceKey: safeId })
  ]),
  options: external_exports.object({
    cli: external_exports.string().min(1).max(128).optional(),
    limit: external_exports.number().int().positive().max(2e3).optional(),
    offset: external_exports.number().int().nonnegative().optional(),
    includeTokenPrice: external_exports.literal(true).optional()
  }).optional()
});
var NativeReadIdentitySchema = external_exports.object({
  entity: external_exports.enum(["project", "milestone", "task", "session"]),
  id: safeId
});
var NativeListAllPunchesSchema = external_exports.object({ limit: external_exports.number().int().positive().max(5e3).optional() }).optional();

var WeakCliIdSchema = external_exports.string().min(1).max(64);
var CorePunchIdSchema = external_exports.string().regex(/^[1-9][0-9]{0,18}$/u).refine((value) => BigInt(value) <= 9223372036854775807n);
var PunchesListForTaskSchema = external_exports.object({
  taskId: external_exports.string().min(1),
  includeTokenPrice: external_exports.literal(true).optional(),
  cli: WeakCliIdSchema.optional(),
  limit: external_exports.number().int().positive().max(2e3).optional(),
  offset: external_exports.number().int().min(0).optional()
});
var PunchesListForTasksSchema = external_exports.object({
  taskIds: external_exports.array(external_exports.string().min(1).max(512)).max(2e3),
  limit: external_exports.number().int().positive().max(2e3).default(200)
}).strict();
var PunchesListAllSchema = external_exports.object({
  limit: external_exports.number().int().positive().max(5e3).optional()
});
var PunchesGetArtifactsSchema = external_exports.object({
  punchSessionId: external_exports.string().min(1),
  punchUid: external_exports.string().min(1),
  taskId: external_exports.string().min(1).optional()
});
var PunchesListChangedFilesForTaskSchema = external_exports.object({
  taskId: external_exports.string().min(1),
  sessionId: external_exports.string().min(1).optional(),
  cwd: external_exports.string().min(1).optional(),
  appSessionId: external_exports.string().min(1).optional()
});
var PunchesListChangedFilesForWebSchema = external_exports.object({
  taskId: external_exports.string().min(1),
  sessionId: external_exports.string().min(1)
});
var PunchChangedFileActionSchema = external_exports.object({
  sessionId: external_exports.string().min(1),
  taskId: external_exports.string().min(1),
  fileId: external_exports.string().min(1).max(512),
  action: external_exports.enum(["preview", "download", "directory"])
});
var PunchesGetTranscriptSchema = external_exports.object({
  punchUid: external_exports.string().min(1).optional(),
  punchId: CorePunchIdSchema.optional(),
  taskId: external_exports.string().min(1).optional(),
  cli: external_exports.string().optional(),
  cursor: external_exports.string().max(128).nullable().optional(),
  mode: external_exports.literal("timeline").optional(),
  detailToken: external_exports.string().min(1).max(128).optional()
}).refine((value) => value.punchId === void 0 !== (value.punchUid === void 0)).refine((value) => value.punchId === void 0 || value.taskId !== void 0).refine((value) => value.detailToken === void 0 || value.cursor == null && value.mode === void 0);
var PunchesGetLatestResponsesSchema = external_exports.object({
  screenSessionId: external_exports.string().min(1).max(512),
  taskId: external_exports.string().min(1).max(512),
  punchIds: external_exports.array(CorePunchIdSchema).min(1).max(20)
}).strict();
var PunchesGetChatTimelineSchema = external_exports.union([external_exports.object({
  taskId: external_exports.string().min(1).max(512),
  punchIds: external_exports.array(CorePunchIdSchema).min(1).max(2e3)
}).strict(), external_exports.object({
  taskId: external_exports.string().min(1).max(512),
  punchUids: external_exports.array(external_exports.string().min(1).max(512)).min(1).max(2e3)
}).strict()]);

var MonitorStartSchema = external_exports.object({
  sessionId: external_exports.string().min(1),
  taskId: external_exports.string().min(1),
  projectPath: external_exports.string(),
  milestoneId: external_exports.string().nullish(),
  sinceMs: external_exports.number().optional()
});
var MonitorStopSchema = external_exports.object({
  sessionId: external_exports.string().min(1)
});
var MonitorRebindSchema = external_exports.object({
  sessionId: external_exports.string().min(1),
  externalId: external_exports.string().nullable()
});

var WEB_STRIPPED_PATH_SOURCE_FIELDS = Object.freeze({
  "tasks:create": Object.freeze(["projectLocalId", "folderPath", "folderPathSnapshot"])
});

var MAX_SCHEDULE_STEPS = 10;

var WatchOptionsSchema = external_exports.object({
  recursive: external_exports.boolean().optional(),
  batchMode: external_exports.enum(["batch", "each"]).optional(),
  minIntervalMs: external_exports.number().int().nonnegative().optional(),
  hourlyCap: external_exports.number().int().nonnegative().optional(),
  dailyCap: external_exports.number().int().nonnegative().optional(),
  catchupMode: external_exports.enum(["batch", "off"]).optional(),
  includeHidden: external_exports.boolean().optional(),
  ignoreExtra: external_exports.array(external_exports.string()).optional()
});
var ScheduleRuleObjectSchema = external_exports.object({
  ruleKind: external_exports.enum(["once", "daily", "weekly", "interval", "watch"]),
  atMs: external_exports.number().int().positive().optional(),
  timeOfDay: external_exports.string().regex(/^\d{2}:\d{2}$/).optional(),
  daysOfWeek: external_exports.array(external_exports.number().int().min(0).max(6)).optional(),
  intervalMinutes: external_exports.number().int().positive().optional(),
  watchPath: external_exports.string().min(1).optional(),
  watchEvents: external_exports.array(external_exports.enum(["file", "dir"])).optional(),
  watchOptions: WatchOptionsSchema.optional()
});
var ScheduleRuleSchema = ScheduleRuleObjectSchema.superRefine((rule, ctx) => {
  switch (rule.ruleKind) {
    case "once":
      if (rule.atMs === void 0) {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ["atMs"],
          message: "once 規則必須提供 atMs（絕對觸發時刻）"
        });
      }
      break;
    case "daily":
      if (rule.timeOfDay === void 0) {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ["timeOfDay"],
          message: "daily 規則必須提供 timeOfDay（HH:MM）"
        });
      }
      break;
    case "weekly":
      if (rule.timeOfDay === void 0) {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ["timeOfDay"],
          message: "weekly 規則必須提供 timeOfDay（HH:MM）"
        });
      }
      if (rule.daysOfWeek === void 0 || rule.daysOfWeek.length === 0) {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ["daysOfWeek"],
          message: "weekly 規則必須提供至少一個 daysOfWeek（0=週日..6=週六）"
        });
      }
      break;
    case "interval":
      if (rule.intervalMinutes === void 0) {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ["intervalMinutes"],
          message: "interval 規則必須提供 intervalMinutes（正整數，每 N 分鐘）"
        });
      }
      break;
    case "watch":
      if (rule.watchPath === void 0) {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ["watchPath"],
          message: "watch 規則必須提供 watchPath（要監看的資料夾）"
        });
      } else if (!/^([/\\]|[A-Za-z]:[/\\])/.test(rule.watchPath)) {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ["watchPath"],
          message: "watchPath 必須是絕對路徑"
        });
      }
      if (rule.watchEvents === void 0 || rule.watchEvents.length === 0) {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ["watchEvents"],
          message: "watch 規則必須至少選一種監看內容（新增檔案／新增資料夾）"
        });
      }
      break;
  }
});

var SCHEDULE_TOOL_IDS = ["claude", "codex"];
var DEFAULT_SCHEDULE_TOOL = SCHEDULE_TOOL_IDS[0];
var ScheduleSourceSchema = external_exports.object({
  originKind: external_exports.literal("fork_segments"),
  sourceSessionId: external_exports.string().optional(),
  sourceTaskId: external_exports.string().optional(),
  attachmentPath: external_exports.string().min(1)
});
var ScheduleStepSchema = external_exports.object({
  prompt: external_exports.string(),
  assigneeSkill: external_exports.string().optional()
}).strict();
var ScheduleCreateSchema = external_exports.object({
  title: external_exports.string().min(1),
  tool: external_exports.enum(SCHEDULE_TOOL_IDS),
  projectPath: external_exports.string().min(1),
  projectLocalId: external_exports.string().min(1).nullable().optional(),
  prompt: external_exports.string().default(""),
  permissionMode: external_exports.enum(["max", "default"]).default("max"),
  rule: ScheduleRuleSchema,
  source: ScheduleSourceSchema.optional(),
  assigneeSkill: external_exports.string().optional(),
  model: external_exports.string().max(512).optional(),
  effort: external_exports.string().max(512).optional(),
  steps: external_exports.array(ScheduleStepSchema).max(MAX_SCHEDULE_STEPS).optional()
});
var ScheduleUpdateSchema = ScheduleCreateSchema.partial().extend({
  id: external_exports.string().min(1)
});
var ScheduleIdSchema = external_exports.object({ id: external_exports.string().min(1) });
var ScheduleSetEnabledSchema = external_exports.object({
  id: external_exports.string().min(1),
  enabled: external_exports.boolean()
});
var ScheduleRunNowSchema = external_exports.object({ id: external_exports.string().min(1) });
var ScheduleRevealSchema = external_exports.object({ runId: external_exports.string().min(1) });
var ScheduleMarkRunViewedSchema = external_exports.object({ runId: external_exports.string().min(1) });
var ScheduleListRunsInRangeSchema = external_exports.object({
  fromMs: external_exports.number().int(),
  toMs: external_exports.number().int()
});

var SELECTED_CONVERSATION_LIMITS = Object.freeze({
  page: 100,
  range: 500,
  rows: 200,
  rowBytes: 256 * 1024,
  oversizedMarkers: 16,
  chunkBytes: 128 * 1024,
  recordBytes: 100 * 1024 * 1024,
  metadataBytes: 100 * 1024 * 1024,
  indexBytes: 8 * 1024 * 1024,
  indexRecords: 2e3,
  indexTimeMs: 75,
  segmentRows: 4096
});
var id = external_exports.string().min(1).max(512);
var revision = external_exports.string().min(1).max(128);
var page2 = external_exports.object({ limit: external_exports.number().int().min(1).max(100), cursor: external_exports.string().max(512).nullable(), order: external_exports.enum(["updated_desc", "created_desc"]) }).strict();
var SelectedSessionListRequestSchema = external_exports.object({
  scope: external_exports.object({ projectId: id.nullable(), taskId: id.nullable() }).strict().optional(),
  provider: external_exports.string().min(1).max(64).nullable().optional(),
  page: page2
}).strict();
var SelectedConversationBindingRequestSchema = external_exports.object({ screenSessionId: id, expectedRevision: external_exports.number().int().nonnegative().safe(), selectionEpoch: external_exports.number().int().nonnegative().safe() }).strict();
var SelectedConversationRangeRequestSchema = external_exports.object({ screenSessionId: id, expectedRevision: revision, startSequence: external_exports.number().int().nonnegative().safe(), endSequence: external_exports.number().int().nonnegative().safe(), limit: external_exports.number().int().min(1).max(500).optional() }).strict();
var SelectedConversationWindowRequestSchema = external_exports.object({ screenSessionId: id, expectedRevision: revision, startSequence: external_exports.number().int().nonnegative().safe().optional(), afterSegment: external_exports.number().int().nonnegative().safe().optional(), limit: external_exports.number().int().min(1).max(500).optional() }).strict();
var SelectedConversationSearchRequestSchema = external_exports.object({ screenSessionId: id, expectedRevision: revision, query: external_exports.string().min(1).max(4096), cursor: external_exports.string().max(1024).nullable(), limit: external_exports.number().int().min(1).max(100).optional() }).strict();
var SelectedConversationMetadataRequestSchema = external_exports.object({ screenSessionId: id }).strict();
var SelectedConversationCancelRequestSchema = external_exports.object({ screenSessionId: id, selectionEpoch: external_exports.number().int().nonnegative().safe().optional() }).strict();
var SelectedConversationTransportSchemas = Object.freeze({
  listSessions: SelectedSessionListRequestSchema,
  metadata: SelectedConversationMetadataRequestSchema,
  bind: SelectedConversationBindingRequestSchema,
  rebind: SelectedConversationBindingRequestSchema,
  segments: SelectedConversationWindowRequestSchema,
  window: SelectedConversationWindowRequestSchema,
  range: SelectedConversationRangeRequestSchema,
  search: SelectedConversationSearchRequestSchema,
  cancel: SelectedConversationCancelRequestSchema
});

var PROMPT_MATCH_FALLBACK_MS = 5 * 6e4;
var COMPLETION_STALL_TIMEOUT_MS = 90 * 6e4;
var COMPLETION_ABSOLUTE_TIMEOUT_MS = 86400 * 1e3;
var PENDING_COMPLETED_MAX_WAIT_MS = 5 * 6e4;

var RUN_STATE_LABEL = {
  running: "AI 執行中",
  waiting: "等你回覆",
  error: "AI 已中斷",
  completed: "AI 已完成",
  idle: "閒置",
  none: "尚未執行",
  unknown: "狀態暫不可用"
};
var WORKFLOW_STATUS_LABEL = Object.freeze({
  queued: "排隊中",
  pending: "排隊中",
  waiting: "等待中",
  cancelled: "已取消",
  canceled: "已取消"
});
var PUNCH_STATUS_LABEL = {
  running: RUN_STATE_LABEL.running,
  done: "工時已記錄",
  interrupted: RUN_STATE_LABEL.error,
  error: "紀錄異常",
  attention: "待登入",
  unknown: "狀態不明"
};
var TERMINAL_VIEW_LABEL = "原始畫面";
var TERMINAL_VIEW_ACTION_LABEL = `查看${TERMINAL_VIEW_LABEL}`;
var BOARD_COLUMN_LABEL = {
  PREPARATION: "準備中",
  WAITING: "待執行",
  IN_PROGRESS: "進行中",
  PENDING_CONFIRMATION: "待確認",
  PENDING: "暫停",
  COMPLETED: "完成",
  EXTERNAL: "外部對話",
  SYSTEM: "系統對話"
};

var SESSION_INPUT_SESSION_ID_MAX_LENGTH = 512;
var SESSION_INPUT_REQUEST_ID_MAX_LENGTH = 512;
var SESSION_INPUT_TEXT_MAX_LENGTH = 2 * 1024 * 1024;
var SessionInputSessionIdSchema = external_exports.string().min(1).max(SESSION_INPUT_SESSION_ID_MAX_LENGTH);
var SessionInputRequestIdSchema = external_exports.string().min(1).max(SESSION_INPUT_REQUEST_ID_MAX_LENGTH);
var SessionInputTextSchema = external_exports.string().max(SESSION_INPUT_TEXT_MAX_LENGTH);
var SESSION_INPUT_DELIVERY_STATES = ["queued", "dispatching", "original-written", "enter-pending", "submitted", "delivered", "failed", "cancelled"];
var SessionInputDeliveryStateSchema = external_exports.enum(SESSION_INPUT_DELIVERY_STATES);
var SessionInputEnqueueCommandSchema = external_exports.object({ sessionId: SessionInputSessionIdSchema, requestId: SessionInputRequestIdSchema, text: SessionInputTextSchema }).strict();
var SessionConnectionRepairCommandSchema = external_exports.object({ sessionId: SessionInputSessionIdSchema }).strict();
var SessionConnectionRepairResultSchema = external_exports.object({
  status: external_exports.enum(["ready", "needs-user", "failed", "unsupported"]),
  message: external_exports.string().min(1).max(500)
}).strict();
var SessionQueueMutationIdentitySchema = external_exports.object({ sessionId: SessionInputSessionIdSchema, requestId: SessionInputRequestIdSchema }).strict();
var SessionQueueEditCommandSchema = SessionQueueMutationIdentitySchema.extend({ text: SessionInputTextSchema }).strict();
var SessionQueueMutationResultSchema = external_exports.object({ requestId: SessionInputRequestIdSchema, ok: external_exports.boolean(), reason: external_exports.string().min(1).max(200).optional() }).strict();
var SESSION_PROGRESS_PHASES = [
  "idle",
  "queued-cli-starting",
  "queued-busy",
  "queued-blocked",
  "launching-cli",
  "dispatching",
  "awaiting-response",
  "stalled",
  "halted",
  "frozen",
  "failed"
];
var SessionProgressPhaseSchema = external_exports.enum(SESSION_PROGRESS_PHASES);
var SessionQueueGetSnapshotQuerySchema = external_exports.object({ sessionId: SessionInputSessionIdSchema }).strict();
var SessionQueueFailureSchema = external_exports.object({ code: external_exports.string().min(1), writeRetryable: external_exports.boolean(), textWritten: external_exports.boolean() }).strict();
var SessionQueueRecordFlagsSchema = external_exports.object({ stalled: external_exports.boolean(), stalledSinceMs: external_exports.number().nullable(), abandoned: external_exports.boolean(), abandonedAtMs: external_exports.number().nullable() }).strict();
var SessionQueueSnapshotSchema = external_exports.object({ revision: external_exports.number().int().nonnegative(), queuedRequestIds: external_exports.array(SessionInputRequestIdSchema), activeRequestId: SessionInputRequestIdSchema.nullable(), states: external_exports.record(external_exports.string(), SessionInputDeliveryStateSchema), failures: external_exports.record(external_exports.string(), SessionQueueFailureSchema), flags: external_exports.record(external_exports.string(), SessionQueueRecordFlagsSchema), haltedRequestId: SessionInputRequestIdSchema.nullable(), frozen: external_exports.boolean(), phase: SessionProgressPhaseSchema.optional(), phaseSinceMs: external_exports.number().optional(), activeRequestSinceMs: external_exports.number().int().nonnegative().optional() }).strict();
var EMPTY_SESSION_INPUT_QUEUE_SNAPSHOT = Object.freeze({ revision: 0, queuedRequestIds: Object.freeze([]), activeRequestId: null, states: Object.freeze({}), failures: Object.freeze({}), flags: Object.freeze({}), haltedRequestId: null, frozen: false });
var SessionQueueSnapshotPushSchema = external_exports.object({ sessionId: SessionInputSessionIdSchema, snapshot: SessionQueueSnapshotSchema }).strict();
var SessionQueueLifecycleEventKindSchema = external_exports.enum(["enqueued", "prioritized", "cancelled", "edited", "state-changed", "stalled", "abandoned"]);
var SessionQueueEventPushSchema = external_exports.object({ sessionId: SessionInputSessionIdSchema, requestId: SessionInputRequestIdSchema, kind: SessionQueueLifecycleEventKindSchema, state: SessionInputDeliveryStateSchema, previousState: SessionInputDeliveryStateSchema.optional(), at: external_exports.number() }).strict();
var SessionInterruptSchema = external_exports.object({ sessionId: external_exports.string().min(1) }).strict();

var AI_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
var ProviderId = external_exports.string().regex(AI_PROVIDER_ID_PATTERN);
var AI_MODEL_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
var ModelId = external_exports.string().regex(AI_MODEL_ID_PATTERN);
var AI_EFFORT_VALUE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
var EffortValue = external_exports.string().regex(AI_EFFORT_VALUE_PATTERN);
var AiSessionDefaultsSchema = external_exports.record(
  ProviderId,
  external_exports.object({ model: ModelId.nullable(), effort: EffortValue.nullable() }).strict()
);
var AI_FOLDER_PERMISSION_VALUE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
var FolderPermissionValue = external_exports.string().regex(AI_FOLDER_PERMISSION_VALUE_PATTERN);
var FolderSessionDefaultsProviderValuesSchema = external_exports.object({
  model: ModelId.nullable(),
  effort: EffortValue.nullable(),
  permission: FolderPermissionValue.nullable()
}).strict();
var FolderSessionDefaultsDocumentSchema = external_exports.object({ folderPath: external_exports.string().min(1).max(4096) }).catchall(FolderSessionDefaultsProviderValuesSchema);
var AI_MODEL_CATALOG_MAX_ENTRIES = 50;
var AI_MODEL_EFFORT_VALUES_MAX = 16;
var AiModelCatalogEntrySchema = external_exports.object({
  id: ModelId,
  displayName: external_exports.string().min(1).max(80),
  supportsEffort: external_exports.boolean(),
  effortValues: external_exports.array(EffortValue).max(AI_MODEL_EFFORT_VALUES_MAX),
  contextWindowTokens: external_exports.number().int().positive().max(1e7).nullable(),
  disabled: external_exports.boolean(),
  updatedAtMs: external_exports.number().int().nonnegative()
}).strict();
var AiModelCatalogOverridesSchema = external_exports.record(
  ProviderId,
  external_exports.object({ models: external_exports.array(AiModelCatalogEntrySchema).max(AI_MODEL_CATALOG_MAX_ENTRIES) }).strict()
);
var AiModelPricingEntrySchema = external_exports.object({
  input: external_exports.number().min(0).max(1e4),
  output: external_exports.number().min(0).max(1e4),
  cacheRead: external_exports.number().min(0).max(1e4),
  cacheWrite: external_exports.number().min(0).max(1e4),
  updatedAtMs: external_exports.number().int().nonnegative()
}).strict();
var AI_MODEL_PRICING_VARIANT_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/;
var PricingVariantKey = external_exports.string().regex(AI_MODEL_PRICING_VARIANT_KEY_PATTERN);
var AiModelPricingOverrideEntrySchema = external_exports.union([
  AiModelPricingEntrySchema,
  external_exports.record(PricingVariantKey, AiModelPricingEntrySchema)
]);
var AiModelPricingOverridesSchema = external_exports.record(ProviderId, external_exports.record(ModelId, AiModelPricingOverrideEntrySchema));

var NATIVE_OWNED_WORKSPACE_SETTING_KEYS_LIST = [
  "monitor_auto_recover",
  "kanban_poll_seconds",
  "monitor_poll_seconds",
  "cli_onboarding",
  "session_max_permissions",
  "session_permission_memory",
  "session_close_choice",
  "sidebar_task_order",
  "notification_prefs",
  "usage_telemetry",
  "ai_dispatch_tier_policy",
  "chrome_copilot_enabled",
  "chrome_copilot_notice_acknowledged",
  "agent_team_folder_mode",
  "experimental_route_create_to_academy",
  "portal_editor_provider",
  "portal_editor_model",
  "portal_editor_effort",
  "server_toggle_migration_notice",
  "web_gates_migration_notice",
  "agentTeamAvatarOverrides",
  "agentTeamGroups",
  "marketplaceBaseUrl",
  "portalBinding",
  "portalBindLegacyMigration",
  "ai_session_defaults",
  "ai_model_catalog_overrides",
  "ai_model_pricing_overrides",
  "ai_model_pricing_catalog_preferences",
  "official_ai_model_catalog_lkg",
  "web_cwd_confirmed"
];
var NATIVE_OWNED_WORKSPACE_SETTING_KEYS = new Set(
  NATIVE_OWNED_WORKSPACE_SETTING_KEYS_LIST
);

var FiniteNumberSchema = external_exports.number().finite();
var NonNegativeNumberSchema = FiniteNumberSchema.nonnegative();
var NonNegativeIntegerSchema2 = NonNegativeNumberSchema.int();
var TkPublicOverviewAvailableSchema = external_exports.object({
  version: external_exports.literal(1),
  available: external_exports.literal(true),
  lifeToDateCostUsd: NonNegativeNumberSchema,
  last7dCostUsd: NonNegativeNumberSchema,
  prev7dCostUsd: NonNegativeNumberSchema,
  cacheEfficiencyPct: NonNegativeNumberSchema,
  daysCovered: NonNegativeIntegerSchema2.nullable()
}).strict();
var TkPublicOverviewUnavailableSchema = external_exports.object({
  version: external_exports.literal(1),
  available: external_exports.literal(false),
  lifeToDateCostUsd: external_exports.null(),
  last7dCostUsd: external_exports.null(),
  prev7dCostUsd: external_exports.null(),
  cacheEfficiencyPct: external_exports.null(),
  daysCovered: external_exports.null()
}).strict();
var TkPublicOverviewV1Schema = external_exports.discriminatedUnion("available", [
  TkPublicOverviewAvailableSchema,
  TkPublicOverviewUnavailableSchema
]);

var ACTIVE_COLUMNS = [
  { label: BOARD_COLUMN_LABEL.PREPARATION, status: "PREPARATION" },
  { label: BOARD_COLUMN_LABEL.WAITING, status: "WAITING" },
  { label: BOARD_COLUMN_LABEL.IN_PROGRESS, status: "IN_PROGRESS" },
  { label: BOARD_COLUMN_LABEL.PENDING_CONFIRMATION, status: "PENDING_CONFIRMATION" },
  { label: BOARD_COLUMN_LABEL.PENDING, status: "PENDING" },
  { label: BOARD_COLUMN_LABEL.COMPLETED, status: "COMPLETED" },
  { label: BOARD_COLUMN_LABEL.EXTERNAL, status: "EXTERNAL" },
  { label: BOARD_COLUMN_LABEL.SYSTEM, status: "SYSTEM" }
];
var ACTIVE_STATUSES = ACTIVE_COLUMNS.map((c) => c.status);
var KANBAN_VISIBLE_COLUMNS = ACTIVE_COLUMNS.filter((c) => c.status !== "PREPARATION");

var ConfigEditorTargetSchema = external_exports.object({
  provider: external_exports.enum(["codex", "claude"]),
  scope: external_exports.enum(["global", "project"]),
  projectId: external_exports.string().trim().min(1).max(512).optional(),
  folderPath: external_exports.string().trim().min(1).max(4096).optional()
}).strict().superRefine((target, context) => {
  if (target.scope === "project" && !target.projectId) context.addIssue({ code: "custom", path: ["projectId"], message: "專案設定需要專案識別碼。" });
  if (target.scope === "project" && !target.folderPath) context.addIssue({ code: "custom", path: ["folderPath"], message: "專案設定需要資料夾路徑。" });
  if (target.scope === "global" && target.projectId !== void 0) context.addIssue({ code: "custom", path: ["projectId"], message: "全局設定不得攜帶專案識別碼。" });
  if (target.scope === "global" && target.folderPath !== void 0) context.addIssue({ code: "custom", path: ["folderPath"], message: "全局設定不得攜帶資料夾路徑。" });
});
var ConfigEditorSaveSchema = external_exports.object({
  target: ConfigEditorTargetSchema,
  expectedVersion: external_exports.string().regex(/^(?:missing|[a-f0-9]{64})$/u),
  text: external_exports.string().max(512 * 1024)
}).strict();
var ConfigEditorDocumentSchema = external_exports.object({
  path: external_exports.string().min(1).max(4096),
  exists: external_exports.boolean(),
  text: external_exports.string().max(512 * 1024),
  version: external_exports.string().regex(/^(?:missing|[a-f0-9]{64})$/u)
}).strict();
var ConfigEditorErrorCodeSchema = external_exports.enum(["conflict", "invalid-config", "unavailable", "io"]);

var DownloadTransferProgressSchema = external_exports.object({
  downloadedBytes: external_exports.number().finite().int().nonnegative().safe(),
  totalBytes: external_exports.number().finite().int().nonnegative().safe().nullable(),
  bytesPerSecond: external_exports.number().finite().nonnegative().nullable()
}).strict();

var CliUpdateStatusSchema = external_exports.enum([
  "updated",
  "current",
  "partial",
  "failed",
  "skipped",
  "unverified",
  "unchanged"
]);
var CliUpdateActiveStatusSchema = external_exports.enum([
  "updated",
  "current",
  "failed",
  "skipped",
  "unverified",
  "missing",
  "unchanged"
]).nullable();
var CliUpdateOutcomeSchema = external_exports.object({
  status: CliUpdateStatusSchema,
  activeStatus: CliUpdateActiveStatusSchema,
  detail: external_exports.string().max(2048)
}).strict();

var CliUpdateCheckIdSchema = external_exports.string().uuid();
var CliUpdateVersionSchema = external_exports.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
var CliUpdateCheckRequestSchema = external_exports.object({ id: external_exports.string().trim().min(1).max(80) }).strict();
var CliUpdateCheckSchema = external_exports.object({
  checkId: CliUpdateCheckIdSchema,
  id: external_exports.string().trim().min(1).max(80),
  status: external_exports.enum(["available", "current", "unavailable"]),
  source: external_exports.string().min(1).max(80),
  currentVersion: external_exports.string().max(128).nullable(),
  targetVersion: CliUpdateVersionSchema.nullable(),
  targetRelation: external_exports.enum(["newer", "same", "lower", "unknown"]),
  reason: external_exports.string().max(512).nullable(),
  checkedAt: external_exports.number().int().positive()
}).strict();
var CliUpdateCheckResultSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ ok: external_exports.literal(true), data: CliUpdateCheckSchema }).strict(),
  external_exports.object({ ok: external_exports.literal(false), error: external_exports.string().max(1200), code: external_exports.enum(["invalid-request", "unavailable"]).optional() }).strict()
]);
var CliUpdateConfirmRequestSchema = external_exports.object({ checkId: CliUpdateCheckIdSchema }).strict();
var CliUpdateConfirmResultSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({
    ok: external_exports.literal(true),
    data: external_exports.object({ id: external_exports.string().trim().min(1).max(80), outcome: CliUpdateOutcomeSchema, observedVersion: external_exports.string().max(128).nullable() }).strict()
  }).strict(),
  external_exports.object({ ok: external_exports.literal(false), error: external_exports.string().max(1200), code: external_exports.enum(["invalid-request", "unavailable", "expired", "stale-check"]).optional() }).strict()
]);

var ClaudeAutoUpdatesChannelSchema = external_exports.enum(["stable", "latest"]);
var ClaudeAutoUpdatesChannelVersionSchema = external_exports.string().regex(/^(?:missing|[a-f0-9]{64})$/u);
var ClaudeAutoUpdatesChannelReadRequestSchema = external_exports.object({}).strict();
var ClaudeAutoUpdatesChannelSnapshotSchema = external_exports.object({
  channel: ClaudeAutoUpdatesChannelSchema,
  expectedVersion: ClaudeAutoUpdatesChannelVersionSchema,
  channelEditable: external_exports.boolean(),
  unavailableReason: external_exports.string().max(240).nullable()
}).strict();
var ClaudeAutoUpdatesChannelErrorCodeSchema = external_exports.enum([
  "conflict",
  "invalid-config",
  "unavailable",
  "io",
  "unsupported",
  "expired",
  "stale-check"
]);
var ClaudeAutoUpdatesChannelReadResultSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({
    ok: external_exports.literal(true),
    data: ClaudeAutoUpdatesChannelSnapshotSchema
  }).strict(),
  external_exports.object({
    ok: external_exports.literal(false),
    error: external_exports.string().max(1200),
    code: ClaudeAutoUpdatesChannelErrorCodeSchema.optional()
  }).strict()
]);
var ClaudeAutoUpdatesChannelApplyRequestSchema = external_exports.object({
  channel: ClaudeAutoUpdatesChannelSchema,
  expectedVersion: ClaudeAutoUpdatesChannelVersionSchema
}).strict();
var ClaudeAutoUpdatesChannelApplyResultSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({
    ok: external_exports.literal(true),
    data: external_exports.object({
      channel: ClaudeAutoUpdatesChannelSchema,
      savedVersion: ClaudeAutoUpdatesChannelVersionSchema,
      check: CliUpdateCheckSchema
    }).strict()
  }).strict(),
  external_exports.object({
    ok: external_exports.literal(false),
    error: external_exports.string().max(1200),
    code: ClaudeAutoUpdatesChannelErrorCodeSchema.optional()
  }).strict()
]);
var ClaudeAutoUpdatesChannelConfirmRequestSchema = external_exports.object({ checkId: CliUpdateCheckIdSchema }).strict();
var ClaudeAutoUpdatesChannelConfirmResultSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({
    ok: external_exports.literal(true),
    data: external_exports.object({
      channel: ClaudeAutoUpdatesChannelSchema,
      savedVersion: ClaudeAutoUpdatesChannelVersionSchema,
      update: CliUpdateOutcomeSchema,
      observedVersion: external_exports.string().max(128).nullable()
    }).strict()
  }).strict(),
  external_exports.object({
    ok: external_exports.literal(false),
    error: external_exports.string().max(1200),
    code: ClaudeAutoUpdatesChannelErrorCodeSchema.optional()
  }).strict()
]);

var ProviderIdSchema = external_exports.enum(["claude", "codex"]);
var UtcDateTimeSchema = external_exports.string().datetime({ offset: false });
var DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/;
var DecimalSchema = external_exports.string().regex(DECIMAL_PATTERN).nullable();
var ModelIdSchema = external_exports.string().regex(/^(claude|codex):[a-z0-9][a-z0-9._-]{0,63}$/);
var DigestSchema = external_exports.string().regex(/^[a-f0-9]{64}$/);
var ColorHexSchema = external_exports.string().regex(/^#[0-9a-f]{6}$/);
var AiModelCatalogModelColorSchema = external_exports.object({ light: ColorHexSchema, dark: ColorHexSchema }).strict().nullable();
var AiModelCatalogModelSchema = external_exports.object({
  id: ModelIdSchema,
  providerId: ProviderIdSchema,
  displayName: external_exports.string().min(1).max(120),
  aliases: external_exports.array(external_exports.string().min(1).max(80)).refine((items) => new Set(items).size === items.length),
  contextWindowTokens: external_exports.number().int().safe().positive().nullable(),
  effortValues: external_exports.array(external_exports.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)).refine((items) => new Set(items).size === items.length),
  disabled: external_exports.boolean(),
  retired: external_exports.boolean(),
  billingModelId: external_exports.string().min(1).max(128).nullable(),
  color: AiModelCatalogModelColorSchema
}).strict().superRefine((model, ctx) => {
  if (!model.id.startsWith(`${model.providerId}:`)) {
    ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["id"], message: "model_provider_id_mismatch" });
  }
});
var AiModelCatalogRateSchema = external_exports.object({
  id: external_exports.string().min(1).max(240),
  providerId: ProviderIdSchema,
  billingModelId: external_exports.string().min(1).max(128),
  serviceTier: external_exports.enum(["standard", "batch", "flex", "fast"]).nullable(),
  context: external_exports.enum(["short", "long"]).nullable(),
  input: DecimalSchema,
  output: DecimalSchema,
  cacheRead: DecimalSchema,
  cacheWrite: DecimalSchema,
  effectiveFrom: UtcDateTimeSchema.nullable(),
  effectiveTo: UtcDateTimeSchema.nullable(),
  source: external_exports.string().min(1).max(1e3).nullable(),
  dimensionMode: external_exports.enum(["provider_default", "tiered", "undimensioned_legacy"])
}).strict().superRefine((rate, ctx) => {
  if (rate.effectiveFrom && rate.effectiveTo && Date.parse(rate.effectiveTo) <= Date.parse(rate.effectiveFrom)) {
    ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["effectiveTo"], message: "rate_interval_invalid" });
  }
  if (rate.providerId === "claude") {
    if (rate.dimensionMode !== "provider_default" || rate.serviceTier !== null || rate.context !== null) {
      ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["dimensionMode"], message: "claude_dimensions_invalid" });
    }
  } else if (rate.dimensionMode === "tiered") {
    if (rate.serviceTier === null || rate.context === null) {
      ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["dimensionMode"], message: "codex_tiered_dimensions_invalid" });
    }
  } else if (rate.dimensionMode === "undimensioned_legacy") {
    if (rate.serviceTier !== null || rate.context !== null) {
      ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["dimensionMode"], message: "codex_legacy_dimensions_invalid" });
    }
  } else {
    ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["dimensionMode"], message: "codex_provider_default_invalid" });
  }
});
function validateAggregate(value, ctx) {
  const modelIds = value.models.map((model) => model.id);
  const rateIds = value.rates.map((rate) => rate.id);
  if (new Set(modelIds).size !== modelIds.length) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["models"], message: "model_id_duplicate" });
  if (new Set(rateIds).size !== rateIds.length) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["rates"], message: "rate_id_duplicate" });
  const groups = /* @__PURE__ */ new Map();
  value.rates.forEach((rate, index) => {
    const key4 = JSON.stringify([rate.providerId, rate.billingModelId, rate.dimensionMode, rate.serviceTier, rate.context]);
    const interval = { index, start: rate.effectiveFrom === null ? Number.NEGATIVE_INFINITY : Date.parse(rate.effectiveFrom), end: rate.effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(rate.effectiveTo) };
    const rows2 = groups.get(key4) ?? [];
    if (rows2.some((other) => interval.start < other.end && other.start < interval.end)) {
      ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["rates", index], message: "rate_interval_overlap" });
    }
    rows2.push(interval);
    groups.set(key4, rows2);
  });
}
var SnapshotDraftShape = external_exports.object({
  schemaVersion: external_exports.literal(3),
  catalogId: external_exports.literal("claude-codex"),
  models: external_exports.array(AiModelCatalogModelSchema),
  rates: external_exports.array(AiModelCatalogRateSchema)
}).strict();
var AiModelCatalogDraftSchema = SnapshotDraftShape.superRefine(validateAggregate);
var AiModelCatalogPublishedSnapshotSchema = SnapshotDraftShape.extend({
  revision: external_exports.number().int().safe().positive(),
  publishedAt: UtcDateTimeSchema,
  payloadSha256: DigestSchema
}).strict().superRefine(validateAggregate);
var AiModelCatalogLkgSchema = external_exports.object({
  snapshot: AiModelCatalogPublishedSnapshotSchema,
  etag: external_exports.string().regex(/^"sha256:[a-f0-9]{64}"$/)
}).strict().superRefine((lkg, ctx) => {
  if (lkg.etag !== `"sha256:${lkg.snapshot.payloadSha256}"`) {
    ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["etag"], message: "catalog_etag_digest_mismatch" });
  }
});

var AiModelPricingCatalogPreferenceSchema = external_exports.enum(["bundled", "official", "local"]);
var PricingModelIdSchema = external_exports.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
var PricingCellKeySchema = external_exports.string().regex(/^(default|[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*)$/);
var ProviderPreferencesSchema = external_exports.record(
  PricingModelIdSchema,
  external_exports.record(PricingCellKeySchema, AiModelPricingCatalogPreferenceSchema)
);
var AiModelPricingCatalogPreferencesSchema = external_exports.object({
  claude: ProviderPreferencesSchema.optional(),
  codex: ProviderPreferencesSchema.optional()
}).strict();

var WebAuthSessionInfoSchema = external_exports.object({
  tier: external_exports.enum(["anon", "auth"]),
  writeEnabled: external_exports.boolean(),
  execEnabled: external_exports.boolean(),
  deviceLabel: external_exports.string(),
  appVersion: external_exports.string()
});

var ProviderIdSchema2 = external_exports.string().trim().min(1).max(128);
var SubagentPromptTargetSchema = external_exports.object({
  projectId: external_exports.string().trim().min(1).max(160),
  folderPath: external_exports.string().trim().min(1).max(4096),
  providerId: ProviderIdSchema2
}).strict();
var SubagentPromptFieldSchema = external_exports.discriminatedUnion("mode", [
  external_exports.object({ mode: external_exports.literal("inherit") }).strict(),
  external_exports.object({ mode: external_exports.literal("custom"), value: external_exports.string().trim().min(1).max(200) }).strict()
]);
var SubagentPromptOverrideSchema = external_exports.object({
  schemaVersion: external_exports.literal(1),
  model: SubagentPromptFieldSchema,
  effort: SubagentPromptFieldSchema.optional()
}).strict();
var PromptBundleSchema = external_exports.object({
  id: external_exports.string().min(1).max(160),
  version: external_exports.number().int().positive(),
  contentHash: external_exports.string().regex(/^[0-9a-f]{64}$/),
  content: external_exports.string().max(64e3),
  productPolicy: external_exports.string().max(64e3),
  sessionContext: external_exports.string().max(64e3).optional()
}).strict();
var SubagentPromptSettingsDtoSchema = external_exports.object({
  target: SubagentPromptTargetSchema,
  model: external_exports.object({ value: external_exports.string().nullable(), source: external_exports.enum(["folder", "database", "provider-default"]), status: external_exports.enum(["resolved", "unconfigured", "conflict", "unsupported"]), conflict: external_exports.string().nullable() }).strict(),
  effort: external_exports.object({ value: external_exports.string().nullable(), source: external_exports.enum(["folder", "database", "provider-default"]), status: external_exports.enum(["resolved", "unconfigured", "conflict", "unsupported"]), conflict: external_exports.string().nullable() }).strict().nullable(),
  tiers: external_exports.record(external_exports.object({ model: external_exports.string().nullable(), effort: external_exports.string().nullable() }).strict()),
  bundle: PromptBundleSchema,
  status: external_exports.enum(["ready", "unconfigured", "invalid", "unavailable"])
}).strict();
var SubagentPromptLaunchSnapshotSchema = external_exports.object({
  providerId: ProviderIdSchema2,
  scope: external_exports.enum(["global", "project-folder"]),
  target: SubagentPromptTargetSchema.nullable(),
  model: SubagentPromptSettingsDtoSchema.shape.model.nullable(),
  effort: SubagentPromptSettingsDtoSchema.shape.effort,
  tiers: SubagentPromptSettingsDtoSchema.shape.tiers,
  bundle: PromptBundleSchema,
  delivery: external_exports.object({
    supported: external_exports.boolean(),
    conflict: external_exports.string().nullable(),
    plan: external_exports.object({
      contentHash: external_exports.string().regex(/^[0-9a-f]{64}$/),
      mode: external_exports.enum(["native-system", "append-system-file", "profile-config", "message-preamble", "unsupported"]),
      status: external_exports.string().min(1).max(80),
      launchArgs: external_exports.array(external_exports.string().max(8192)).max(64),
      seededFiles: external_exports.array(external_exports.string().max(4096)).max(64),
      messagePreamble: external_exports.string().max(64e3).nullable()
    }).strict().nullable()
  }).strict()
}).strict().superRefine((value, context) => {
  if (value.scope === "global" !== (value.target === null)) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "snapshot scope and target must agree" });
  if (value.target !== null && value.target.providerId !== value.providerId) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "snapshot provider must match target" });
});
var SubagentPromptLaunchSnapshotSummarySchema = external_exports.object({
  sessionId: external_exports.string().trim().min(1).max(512),
  providerId: ProviderIdSchema2,
  contentHash: external_exports.string().regex(/^[0-9a-f]{64}$/)
}).strict();
var SubagentPromptLaunchSnapshotReadSchema = external_exports.object({ sessionId: external_exports.string().trim().min(1).max(512), projection: external_exports.literal("summary").optional() }).strict();
var SubagentPromptWriteSchema = external_exports.object({ target: SubagentPromptTargetSchema, override: SubagentPromptOverrideSchema }).strict();

var requestId3 = external_exports.number().int().positive();
var NativeBackendProcessPacketSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("init"), workerEntry: external_exports.string().min(1), boot: external_exports.object({ nativeBackend: external_exports.literal(1), options: external_exports.unknown(), trustedRendererUrl: external_exports.string(), resourcesPath: external_exports.string(), logFilePath: external_exports.string() }).strict() }).strict(),
  external_exports.object({ kind: external_exports.literal("channel"), channel: external_exports.enum(["electron", "lease"]), message: external_exports.unknown(), requestId: requestId3.optional() }).strict(),
  external_exports.object({ kind: external_exports.literal("response"), requestId: requestId3, bytes: external_exports.custom((bytes4) => bytes4 instanceof Uint8Array && bytes4.byteLength <= 128 * 1024 * 1024) }).strict(),
  external_exports.object({ kind: external_exports.literal("control"), message: external_exports.unknown() }).strict(),
  external_exports.object({ kind: external_exports.literal("status"), message: external_exports.unknown() }).strict()
]);

var PLUGIN_AUTHORING_CHANNELS = Object.freeze({ CREATE: "pluginAuthoring:create" });
var PluginAuthoringRequestSchema = external_exports.object({
  operationId: external_exports.string().uuid(),
  name: external_exports.string().trim().min(1).max(60),
  purpose: external_exports.string().trim().min(3).max(320)
}).strict();
var PluginAuthoringWorkspaceSchema = external_exports.object({
  workspaceId: external_exports.string().min(3).max(96),
  projectPath: external_exports.string().min(1).max(4096),
  name: external_exports.string().min(1).max(60),
  purpose: external_exports.string().min(3).max(320)
}).strict();
var PluginAuthoringResultSchema = external_exports.discriminatedUnion("ok", [
  external_exports.object({ ok: external_exports.literal(true), workspace: PluginAuthoringWorkspaceSchema }).strict(),
  external_exports.object({ ok: external_exports.literal(false), code: external_exports.enum(["invalid_input", "assets_unavailable", "workspace_conflict", "write_failed"]) }).strict()
]);

var id2 = external_exports.string().regex(/^[1-9][0-9]{0,18}$/u).refine((value) => BigInt(value) <= 9223372036854775807n);
var integer = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var text = external_exports.string().nullable();
var ConversationBoardProgressStatusSchema = external_exports.enum(["PREPARATION", "WAITING", "IN_PROGRESS", "PENDING_CONFIRMATION", "PENDING", "COMPLETED"]);
var ConversationBoardCursorSchema = external_exports.object({ updatedAt: integer, id: id2 }).strict();
var search = external_exports.string().max(4096);
var ConversationBoardCountInputSchema = external_exports.object({ search }).strict();
var ConversationBoardPageInputSchema = external_exports.object({ search, status: ConversationBoardProgressStatusSchema, after: ConversationBoardCursorSchema.nullable(), limit: external_exports.number().int().min(1).max(100), revision: external_exports.string().regex(/^[a-f0-9]{32}$/u) }).strict();
var ConversationBoardInventoryPageInputSchema = external_exports.object({ search, after: ConversationBoardCursorSchema.nullable(), limit: external_exports.number().int().min(1).max(100), revision: external_exports.string().regex(/^[a-f0-9]{32}$/u) }).strict();
var ConversationBoardUnlinkedPageInputSchema = external_exports.object({ search, after: ConversationBoardCursorSchema.nullable(), limit: external_exports.number().int().min(1).max(100), revision: external_exports.string().regex(/^[a-f0-9]{32}$/u) }).strict();
var ConversationBoardTaskLookupIssuesPageInputSchema = external_exports.object({ search, after: ConversationBoardCursorSchema.nullable(), limit: external_exports.number().int().min(1).max(100), revision: external_exports.string().regex(/^[a-f0-9]{32}$/u) }).strict();
var ConversationBoardSessionsInputSchema = external_exports.object({ taskId: id2, search, after: ConversationBoardCursorSchema.nullable(), limit: external_exports.number().int().min(1).max(30) }).strict();
var ConversationBoardRequestSchema = external_exports.discriminatedUnion("operation", [
  external_exports.object({ operation: external_exports.literal("countConversationBoard"), input: ConversationBoardCountInputSchema }).strict(),
  external_exports.object({ operation: external_exports.literal("pageConversationBoard"), input: ConversationBoardPageInputSchema }).strict(),
  external_exports.object({ operation: external_exports.literal("pageConversationBoardInventory"), input: ConversationBoardInventoryPageInputSchema }).strict(),
  external_exports.object({ operation: external_exports.literal("pageConversationBoardUnlinkedSessions"), input: ConversationBoardUnlinkedPageInputSchema }).strict(),
  external_exports.object({ operation: external_exports.literal("pageConversationBoardTaskLookupIssues"), input: ConversationBoardTaskLookupIssuesPageInputSchema }).strict(),
  external_exports.object({ operation: external_exports.literal("pageConversationBoardSessions"), input: ConversationBoardSessionsInputSchema }).strict()
]);
var ConversationBoardSessionSummarySchema = external_exports.object({
  durationMs: integer.nullable(),
  costUsd: external_exports.number().finite().nonnegative().nullable(),
  startedAt: integer.nullable(),
  endedAt: integer.nullable(),
  ongoing: external_exports.boolean(),
  subagentCount: integer,
  assignee: external_exports.object({ teamKey: external_exports.string(), agentKey: external_exports.string(), displayName: text }).strict().nullable()
}).strict();
var ConversationBoardSessionItemSchema = SessionPersistedInventoryItemSchema.extend({
  summary: ConversationBoardSessionSummarySchema.optional()
});
var ConversationBoardTaskItemSchema = external_exports.object({
  kind: external_exports.literal("task"),
  id: id2,
  name: external_exports.string(),
  status: external_exports.string(),
  rawStatus: external_exports.string(),
  nativeStatus: text,
  progressStatus: ConversationBoardProgressStatusSchema.nullable(),
  updatedAt: integer,
  projectName: text,
  folderPath: text,
  origin: text,
  teamKey: text,
  punchCount: integer,
  punchFirstStart: integer.nullable(),
  punchLastEnd: integer.nullable(),
  punchOngoing: external_exports.boolean(),
  punchLatestCli: text,
  sessionCount: integer,
  sessions: external_exports.array(ConversationBoardSessionItemSchema).max(3),
  representativeSession: ConversationBoardSessionItemSchema.nullable(),
  nextSessionCursor: ConversationBoardCursorSchema.nullable()
}).strict();
var ConversationBoardLooseItemSchema = external_exports.object({ kind: external_exports.literal("session"), id: id2, updatedAt: integer, session: ConversationBoardSessionItemSchema }).strict();
var ConversationBoardItemSchema = external_exports.discriminatedUnion("kind", [ConversationBoardTaskItemSchema, ConversationBoardLooseItemSchema]);
var ConversationBoardGroupCountSchema = external_exports.object({ total: integer, count: integer, revision: external_exports.string().regex(/^[a-f0-9]{32}$/u) }).strict();
var ConversationBoardCountsSchema = external_exports.object({
  revision: external_exports.string().regex(/^[a-f0-9]{32}$/u),
  columns: external_exports.array(external_exports.object({ status: ConversationBoardProgressStatusSchema, total: integer, count: integer, revision: external_exports.string().regex(/^[a-f0-9]{32}$/u) }).strict()).length(6),
  noProgressTasks: ConversationBoardGroupCountSchema,
  unlinkedSessions: ConversationBoardGroupCountSchema,
  taskLookupIssues: ConversationBoardGroupCountSchema
}).strict();
var ConversationBoardPageSchema = external_exports.object({ items: external_exports.array(ConversationBoardTaskItemSchema).max(100), nextCursor: ConversationBoardCursorSchema.nullable(), stale: external_exports.boolean() }).strict();
var ConversationBoardInventoryPageSchema = external_exports.object({ items: external_exports.array(ConversationBoardTaskItemSchema).max(100), nextCursor: ConversationBoardCursorSchema.nullable(), stale: external_exports.boolean() }).strict();
var ConversationBoardUnlinkedPageSchema = external_exports.object({ items: external_exports.array(ConversationBoardLooseItemSchema).max(100), nextCursor: ConversationBoardCursorSchema.nullable(), stale: external_exports.boolean() }).strict();
var ConversationBoardSessionsSchema = external_exports.object({ items: external_exports.array(ConversationBoardSessionItemSchema).max(30), nextCursor: ConversationBoardCursorSchema.nullable() }).strict();

var identifier4 = external_exports.string().refine((value) => /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n);
var integer2 = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var CorePluginHostDirectoryProjectsInputSchema = external_exports.object({}).strict();
var CorePluginHostSettledWorkChunkInputSchema = external_exports.object({
  afterId: identifier4.nullable(),
  highWatermarkMs: integer2,
  limit: external_exports.number().int().min(1).max(16)
}).strict();
var CorePluginHostDirectoryProjectSchema = external_exports.object({
  id: identifier4,
  name: external_exports.string(),
  archived: external_exports.boolean()
}).strict();
var CorePluginHostDirectoryProjectsSchema = external_exports.array(CorePluginHostDirectoryProjectSchema).max(5e3);
var CorePluginHostSettledWorkRecordSchema = external_exports.object({
  rawId: identifier4,
  agentId: external_exports.string().min(1),
  projectId: identifier4.nullable(),
  sessionId: identifier4.nullable(),
  providerId: external_exports.string().nullable(),
  punchType: external_exports.enum(["main", "subagent"]),
  startedAtMs: integer2,
  endedAtMs: integer2,
  model: external_exports.string().nullable(),
  name: external_exports.string().max(32768).nullable(),
  description: external_exports.string().max(32768).nullable()
}).strict();
var CorePluginHostSettledWorkChunkSchema = external_exports.object({
  records: external_exports.array(CorePluginHostSettledWorkRecordSchema).max(16),
  exhausted: external_exports.boolean()
}).strict();
var CorePluginHostSubagentExportActivationInputSchema = external_exports.object({}).strict();
var CorePluginHostSubagentExportActivationSchema = external_exports.object({
  status: external_exports.enum(["written", "existing"]),
  activatedAtMs: integer2
}).strict();

var identifier5 = external_exports.string().refine((value) => /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n);
var integer3 = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var counter2 = external_exports.union([external_exports.string().regex(/^(0|[1-9][0-9]{0,18})$/u).refine((value) => BigInt(value) <= 9223372036854775807n), integer3]);
var counterText = external_exports.string().regex(/^(0|[1-9][0-9]{0,18})$/u).refine((value) => BigInt(value) <= 9223372036854775807n);
var text2 = external_exports.string().nullable();
var common2 = { id: identifier5, name: external_exports.string(), status: external_exports.string(), description: text2, createdAt: integer3, updatedAt: integer3, archivedAt: integer3.nullable(), authoredRevision: integer3 };
var CoreWorkProjectRowSchema = external_exports.object({ ...common2, status: external_exports.enum(["active", "archived"]) }).strict();
var CoreWorkMilestoneRowSchema = external_exports.object({ ...common2, status: external_exports.enum(["active", "archived"]), projectId: identifier5.nullable(), bindingProjectPath: text2, bindingProvider: text2, bindingLegacyKey: text2, bindingCreatedAtMs: integer3.nullable(), bindingUpdatedAtMs: integer3.nullable() }).strict();
var CoreWorkTaskRowSchema = external_exports.object({ ...common2, projectId: identifier5.nullable(), milestoneId: identifier5.nullable(), origin: text2, folderPath: text2, preferredProvider: text2, nativeStatus: text2, deletedAt: integer3.nullable(), agentTeamKeySnapshot: text2, agentTeamSourceId: identifier5.nullable(), titleSource: text2, titleLockReason: text2, titleUpdatedAt: integer3.nullable(), plannedStartDate: text2, plannedEndDate: text2 }).strict();
var project = CoreWorkProjectRowSchema;
var milestone = CoreWorkMilestoneRowSchema;
var task = CoreWorkTaskRowSchema;
var projectFields = { name: external_exports.string(), description: text2.optional() };
var milestoneFields = { ...projectFields, projectId: identifier5.nullable().optional(), bindingProjectPath: text2.optional(), bindingProvider: text2.optional(), bindingLegacyKey: text2.optional(), bindingCreatedAtMs: integer3.nullable().optional(), bindingUpdatedAtMs: integer3.nullable().optional() };
var taskFields = { ...projectFields, status: external_exports.string(), projectId: identifier5.nullable().optional(), milestoneId: identifier5.nullable().optional(), origin: text2.optional(), folderPath: text2.optional(), preferredProvider: text2.optional(), nativeStatus: text2.optional(), agentTeamKeySnapshot: text2.optional(), agentTeamSourceId: identifier5.nullable().optional(), titleSource: external_exports.string(), titleLockReason: text2.optional(), titleUpdatedAt: integer3.nullable().optional(), plannedStartDate: text2.optional(), plannedEndDate: text2.optional() };
var cas = external_exports.object({ id: identifier5, expectedRevision: integer3, at: integer3 }).strict();
var command = (operation, input) => external_exports.object({ operation: external_exports.literal(operation), input }).strict();
var sessionId4 = identifier5;
var sessionRevision = counter2;
var snapshotRef = external_exports.string().regex(/^[0-9a-f]{64}$/u);
var taskSessionProvider = external_exports.enum(["claude", "codex"]);
var taskSessionNativeId = external_exports.string().min(1).max(512).refine((value) => value.trim() === value && value !== "codex-pending" && value !== "claude-pending" && !value.startsWith("codex:thread:") && !value.startsWith("claude:session:"));
var CoreWorkTaskSessionBindingHistoryEntrySchema = external_exports.object({
  session_id: external_exports.string().min(1).max(512),
  source: taskSessionProvider,
  project_path: external_exports.string().max(4096).nullable(),
  label: external_exports.string().max(512).nullable(),
  first_bound_at: external_exports.string().datetime().nullable(),
  last_bound_at: external_exports.string().datetime().nullable()
}).strict();
var CoreWorkTaskSessionBindingEntrySchema = external_exports.object({
  active: external_exports.string().max(512).nullable(),
  monitoring: external_exports.boolean(),
  history: external_exports.array(CoreWorkTaskSessionBindingHistoryEntrySchema)
}).strict();
var CoreWorkTaskSessionActiveBindingSchema = external_exports.object({
  task_id: identifier5,
  session_id: external_exports.string().min(1).max(512),
  project_path: external_exports.string().max(4096).nullable(),
  source: taskSessionProvider
}).strict();
var taskSessionBinding = CoreWorkTaskSessionBindingEntrySchema;
var taskSessionActiveBinding = CoreWorkTaskSessionActiveBindingSchema;
var CoreWorkSessionSchema = external_exports.object({
  id: sessionId4,
  taskId: sessionId4.nullable(),
  projectId: sessionId4.nullable(),
  provider: text2,
  providerSessionId: text2,
  subagentPromptSnapshotRef: snapshotRef.nullable(),
  titleFallback: text2,
  sessionErrorCode: text2,
  status: external_exports.string(),
  revision: counterText,
  runGeneration: counterText,
  monitorRequested: external_exports.boolean(),
  launchProjectPath: text2,
  launchModel: text2,
  launchEffort: text2,
  permissionMode: text2,
  createdAtMs: integer3,
  updatedAtMs: integer3
}).strict();
var CoreWorkSessionHierarchyRowSchema = external_exports.object({
  sessionId: sessionId4,
  parentSessionId: sessionId4.nullable(),
  status: external_exports.string(),
  provider: text2,
  providerSessionId: text2,
  sourceId: text2,
  sourceRef: text2,
  taskId: sessionId4.nullable(),
  taskStatus: text2,
  taskDeleted: external_exports.boolean(),
  revision: counterText,
  identityRecoveryRequired: external_exports.boolean()
}).strict();
var MonitorStatusValueSchema = external_exports.enum(["history", "new", "realtime", "active"]);
var ObservedStateSchema = external_exports.enum(["unknown", "idle", "running", "waiting", "completed", "error"]);
var ObservedErrorKindSchema = external_exports.enum(["error", "usage_limit", "login_expired"]);
var monitorFamilyFingerprint = external_exports.string().length(32);
var MonitorFamilyExpectedSchema = external_exports.object({ status: external_exports.string().min(1).max(128), hasProviderSessionId: external_exports.boolean(), sessionErrorCode: text2, taskStatus: text2, taskDeleted: external_exports.boolean(), parentSessionId: sessionId4.nullable(), familyFingerprint: monitorFamilyFingerprint }).strict();
var MonitorFamilyRowBaseSchema = external_exports.object({ sessionId: sessionId4, parentSessionId: sessionId4.nullable(), status: external_exports.string(), sessionErrorCode: text2, providerSessionId: text2, sourceRef: text2, isRootStream: external_exports.boolean(), taskId: sessionId4.nullable(), taskStatus: text2, taskDeleted: external_exports.boolean(), monitorStatus: MonitorStatusValueSchema }).strict();
var MonitorFamilyRowSchema = MonitorFamilyRowBaseSchema.extend({ familyFingerprint: monitorFamilyFingerprint }).strict();
var MonitorRosterRowSchema = external_exports.object({ sessionId: sessionId4, monitorStatus: MonitorStatusValueSchema, provider: text2, providerSessionId: text2, sourceId: text2, sourceRef: text2, parentSessionId: sessionId4.nullable(), isRootStream: external_exports.boolean(), taskId: sessionId4.nullable() }).strict();
var nativePunchIdentity = external_exports.record(external_exports.unknown()).nullable();
var nativePunchAssignee = external_exports.object({ teamKey: external_exports.string(), agentKey: external_exports.string(), displayName: text2 }).strict().nullable();
var nativePunchChildLink = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("linked"), sessionId: identifier5, providerSessionId: external_exports.string().min(1), generation: counterText }).strict(),
  external_exports.object({ status: external_exports.literal("missing") }).strict(),
  external_exports.object({ status: external_exports.literal("ambiguous") }).strict()
]);
var CoreNativePunchRowSchema = external_exports.object({
  id: identifier5,
  sourceKey: external_exports.string(),
  taskId: identifier5,
  sessionId: identifier5,
  sourceNativeSessionId: text2,
  status: external_exports.enum(["open", "done", "stale", "cancelled"]),
  punchType: external_exports.enum(["main", "subagent", "workflow", "manual", "unknown"]),
  name: text2,
  description: text2,
  tool: text2,
  startedAtMs: integer3,
  endedAtMs: integer3.nullable(),
  hours: external_exports.number().finite().nullable(),
  settlementState: external_exports.enum(["unsettled", "settled", "failed", "unknown"]),
  detail: external_exports.record(external_exports.unknown()).nullable(),
  identity: nativePunchIdentity,
  assignee: nativePunchAssignee,
  usage: external_exports.unknown().nullable(),
  model: text2.optional(),
  effort: text2.optional(),
  durationMs: integer3.nullable(),
  childLink: nativePunchChildLink.nullable().optional()
}).strict();
var CorePunchListCursorSchema = external_exports.object({ startedAtMs: integer3, id: identifier5 }).strict();
var punchListCursorInput = { cursorStartedAtMs: integer3.optional(), cursorId: identifier5.optional() };
var CoreOpenPunchSettlementRowSchema = external_exports.object({
  punchId: identifier5,
  taskId: identifier5,
  sessionId: identifier5,
  punchType: external_exports.enum(["main", "subagent", "workflow", "manual", "unknown"]),
  startedAtMs: integer3,
  updatedAtMs: integer3,
  lastMessageMs: integer3.nullable(),
  sessionStatus: external_exports.string().min(1).nullable(),
  sessionLastMessageMs: integer3.nullable(),
  sourceMtimeMs: integer3.nullable(),
  sourceComplete: external_exports.boolean(),
  childLink: external_exports.enum(["linked", "missing", "ambiguous"]).nullable()
}).strict();
var sessionFailure = external_exports.object({ status: external_exports.enum(["stale", "missing", "deleted", "conflict"]), currentRevision: sessionRevision.optional() }).strict();
var sessionOutcome = (value) => external_exports.union([
  external_exports.object({ status: external_exports.literal("updated"), session: value }).strict(),
  sessionFailure
]);
var identityOutcome = external_exports.union([
  external_exports.object({ status: external_exports.enum(["updated", "unchanged"]), session: CoreWorkSessionSchema }).strict(),
  sessionFailure
]);
var resumeOutcome = external_exports.union([identityOutcome, external_exports.object({ status: external_exports.literal("ownership_pending"), sessionId: sessionId4 }).strict()]);
var revisionInput = external_exports.union([counter2, external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]);
var sessionCas = external_exports.object({ sessionId: sessionId4, expectedRevision: revisionInput, at: integer3 });
var punchRef = external_exports.object({ kind: external_exports.literal("id"), id: identifier5 }).strict();
var punchWriteOutcome = external_exports.union([
  external_exports.object({ status: external_exports.enum(["written", "reused-same-task"]), localId: external_exports.string() }).strict(),
  external_exports.object({ status: external_exports.enum(["reused-foreign", "missing", "collision", "invalid", "closed", "unavailable"]), localId: external_exports.string().optional(), error: external_exports.string() }).strict()
]);
var punchUsage = external_exports.record(external_exports.unknown()).nullable().optional();
var punchIdentity = external_exports.record(external_exports.unknown()).nullable().optional();
var punchAssignee = nativePunchAssignee.optional();
var workflowPunchDerived = external_exports.object({ name: text2, description: text2, assignee: nativePunchAssignee, usage: external_exports.record(external_exports.unknown()).nullable(), model: text2, effort: text2 }).strict();
var workflowPunchDerivedUpdate = external_exports.object({ taskId: identifier5, sessionId: identifier5, punchId: identifier5, expected: workflowPunchDerived, next: workflowPunchDerived }).strict();
var workflowPunchDerivedOutcome = external_exports.enum(["updated", "unchanged", "stale", "protected", "missing"]);
var punchStart = external_exports.object({
  requestId: external_exports.string().regex(/^[0-9a-f]{64}$/u),
  inputDigest: external_exports.string().regex(/^[0-9a-f]{64}$/u),
  downstreamBatchId: external_exports.string().regex(/^[0-9a-f]{64}$/u).optional(),
  receiptSourceSessionId: identifier5.optional(),
  receiptSourceRevision: counterText.optional(),
  receiptGeneration: counterText.optional(),
  punchUid: external_exports.string().min(1).optional(),
  taskId: identifier5,
  sessionId: identifier5,
  punchType: external_exports.enum(["main", "subagent", "workflow", "manual", "unknown"]),
  name: external_exports.string(),
  startedAtMs: integer3,
  description: text2.optional(),
  cliId: text2.optional(),
  identitySnapshot: punchIdentity,
  model: text2.optional(),
  effort: text2.optional(),
  assignee: punchAssignee,
  usage: punchUsage,
  sourceNativeSessionId: text2.optional(),
  at: integer3.optional()
});
var manualPunchChange = ConversationManualZeroLengthChangeBaseSchema.extend({ punchId: identifier5, sessionId: sessionId4, expectedOperationId: external_exports.string().min(1).max(256).optional() }).strict().superRefine(refineConversationManualZeroLengthChange);
var commitConversationWorkInput = external_exports.object({ operationId: external_exports.string().min(1).max(256), mode: external_exports.enum(["apply", "restore"]), changes: external_exports.array(manualPunchChange).max(100), at: integer3 }).strict().superRefine((input, context) => {
  if (input.mode === "restore" && input.changes.some((change) => !change.expectedOperationId)) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "restore change requires the applied operation id", path: ["changes"] });
});
var nativeSessionRef = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("teamuq"), sessionId: identifier5 }).strict(),
  external_exports.object({ kind: external_exports.literal("provider"), provider: external_exports.string().max(256).refine((value) => value.trim().length > 0), sessionId: external_exports.string().max(4096).refine((value) => value.trim().length > 0), taskId: identifier5.nullable() }).strict()
]);
var CoreWorkNativePageInputSchema = external_exports.object({ limit: external_exports.number().int().min(1).max(100), offset: integer3, after: external_exports.object({ updatedAt: integer3, id: identifier5 }).strict().nullable(), search: external_exports.string().max(32768).refine((value) => value.trim().length > 0).nullable(), projectId: identifier5.nullable(), session: nativeSessionRef.nullable(), statuses: external_exports.array(external_exports.string().max(256).refine((value) => value.trim().length > 0)).max(100) }).strict();
var localTimeZone = external_exports.string().min(1).max(64).regex(/^[A-Za-z0-9_+/-]+$/u);
var CoreWorkProjectTaskSummaryInputSchema = ProjectTaskSummaryInputSchema.extend({ timeZone: localTimeZone }).strict();
var CoreWorkProjectTaskSummarySchema = ProjectTaskSummarySchema;
var CoreWorkProjectTaskStatsPageInputSchema = external_exports.object({ limit: external_exports.number().int().min(1).max(100), after: identifier5.nullable(), timeZone: localTimeZone }).strict();
var CoreWorkProjectTaskStatsPageSchema = external_exports.object({ uncategorized: ProjectTaskStatsUncategorizedSchema.nullable(), items: external_exports.array(ProjectTaskStatsItemSchema).max(100), hasMore: external_exports.boolean() }).strict();
var pageInput = CoreWorkNativePageInputSchema;
var nativeTask = task.extend({ currentSessionId: identifier5.nullable(), currentSessionRevision: counterText, projectName: text2, milestoneName: text2, punchFirstStart: integer3.nullable(), punchLastEnd: integer3.nullable(), punchOngoing: external_exports.boolean().nullable(), punchCount: integer3, punchLatestCli: text2 }).strict();
var nativeProject = project.extend({ lastUsedAt: integer3.nullable() }).strict();
var CoreWorkNativePageSchema = (row) => external_exports.object({ items: external_exports.array(row).max(100), hasMore: external_exports.boolean() }).strict();
var pageReply = CoreWorkNativePageSchema;
var CoreWorkCommandSchema = external_exports.discriminatedUnion("operation", [
  command("countConversationBoard", ConversationBoardCountInputSchema),
  command("pageConversationBoard", ConversationBoardPageInputSchema),
  command("pageConversationBoardInventory", ConversationBoardInventoryPageInputSchema),
  command("pageConversationBoardUnlinkedSessions", ConversationBoardUnlinkedPageInputSchema),
  command("pageConversationBoardTaskLookupIssues", ConversationBoardTaskLookupIssuesPageInputSchema),
  command("pageConversationBoardSessions", ConversationBoardSessionsInputSchema),
  command("deleteProject", external_exports.object({ id: identifier5 }).strict()),
  command("deleteMilestone", external_exports.object({ id: identifier5 }).strict()),
  command("pageProjects", pageInput),
  command("pageMilestones", pageInput),
  command("pageTasks", pageInput),
  command("projectTaskSummary", CoreWorkProjectTaskSummaryInputSchema),
  command("pageProjectTaskStats", CoreWorkProjectTaskStatsPageInputSchema),
  command("listProjectsByFolder", pageInput.extend({ folderPath: external_exports.string().max(4096).refine((value) => value.trim().length > 0) }).strict()),
  command("getNativeTask", external_exports.object({ id: identifier5 }).strict()),
  command("getMilestone", external_exports.object({ id: identifier5 }).strict()),
  command("findTaskBySessionId", external_exports.object({ session: nativeSessionRef }).strict()),
  command("listProjectFolders", external_exports.object({ projectId: identifier5 }).strict()),
  command("listUsedFolders", external_exports.object({}).strict()),
  command("linkProjectFolder", external_exports.object({ projectId: identifier5, folderPath: external_exports.string().max(4096).refine((value) => value.trim().length > 0), at: integer3 }).strict()),
  command("unlinkProjectFolder", external_exports.object({ projectId: identifier5, folderPath: external_exports.string().max(4096).refine((value) => value.trim().length > 0), at: integer3 }).strict()),
  command("listProjects", external_exports.object({ status: external_exports.enum(["active", "archived"]).optional(), search: external_exports.string().optional() }).strict()),
  command("getProject", external_exports.object({ id: identifier5 }).strict()),
  command("createProject", external_exports.object({ ...projectFields, at: integer3 }).strict()),
  command("updateProject", external_exports.object(projectFields).partial().extend(cas.shape).strict()),
  command("archiveProject", cas),
  command("listMilestones", external_exports.object({ projectId: identifier5.nullable().optional(), status: external_exports.enum(["active", "archived"]).optional() }).strict()),
  command("createMilestone", external_exports.object({ ...milestoneFields, at: integer3 }).strict()),
  command("updateMilestone", external_exports.object(milestoneFields).partial().extend(cas.shape).strict()),
  command("archiveMilestone", cas),
  command("listTasks", external_exports.object({ projectId: identifier5.nullable().optional(), milestoneId: identifier5.nullable().optional(), status: external_exports.string().optional(), includeDeleted: external_exports.boolean().optional() }).strict()),
  command("getTask", external_exports.object({ id: identifier5 }).strict()),
  command("createTask", external_exports.object({ ...taskFields, at: integer3 }).strict()),
  command("updateTask", external_exports.object(taskFields).partial().extend({ titleSource: text2.optional() }).extend(cas.shape).strict()),
  command("archiveTask", cas),
  command("softDeleteTask", cas),
  command("createOrAdoptSession", external_exports.object({ taskId: identifier5, provider: external_exports.string().min(1), providerSessionId: external_exports.string().min(1), status: external_exports.string().min(1), expectedCurrentSessionRevision: revisionInput, at: integer3, launchProjectPath: text2.optional(), launchModel: text2.optional(), launchEffort: text2.optional(), permissionMode: text2.optional() }).strict()),
  command("createDraftSession", external_exports.object({ taskId: sessionId4.nullable(), projectId: sessionId4.nullable(), provider: external_exports.string().min(1).max(128).refine((value) => value.trim() === value).nullable(), providerSessionId: text2.optional(), at: integer3, launchProjectPath: text2.optional(), launchModel: text2.optional(), launchEffort: text2.optional(), permissionMode: text2.optional(), titleFallback: text2.optional() }).strict().refine((value) => value.providerSessionId == null || value.provider !== null)),
  command("ensureUnassignedSessionTasks", external_exports.object({ at: integer3, limit: external_exports.number().int().positive().max(128) }).strict()),
  command("bindTaskSession", external_exports.object({ taskId: identifier5, sessionId: identifier5.nullable(), expectedCurrentSessionRevision: revisionInput, at: integer3 }).strict()),
  command("advanceRunGeneration", sessionCas.strict()),
  command("setMonitorIntent", sessionCas.extend({ requested: external_exports.boolean() }).strict()),
  command("setMonitorStatusFamily", external_exports.object({ rootSessionId: sessionId4, value: MonitorStatusValueSchema, expected: MonitorFamilyExpectedSchema }).strict()),
  command("listMonitorRoster", external_exports.object({ afterId: sessionId4.optional(), limit: external_exports.number().int().min(1).max(200) }).strict()),
  command("listSessionFamilies", external_exports.object({ sessionIds: external_exports.array(sessionId4).min(1).max(200), afterId: sessionId4.optional(), limit: external_exports.number().int().min(1).max(100) }).strict()),
  command("monitorProjectorLease", external_exports.object({ action: external_exports.enum(["acquire", "probe", "release"]) }).strict()),
  command("listMonitorReconcileCandidates", external_exports.object({ afterId: sessionId4.optional(), limit: external_exports.number().int().min(1).max(200) }).strict()),
  command("commitObservedState", external_exports.object({ sessionId: sessionId4, providerSessionId: external_exports.string().min(1).max(512).nullable(), state: ObservedStateSchema }).strict()),
  command("acknowledgeObservedCompletion", external_exports.object({ sessionId: sessionId4 }).strict()),
  command("getObservedState", external_exports.object({ sessionId: sessionId4 }).strict()),
  command("resetStaleObservedStates", external_exports.object({}).strict()),
  command("listMonitorRecoveryCandidates", external_exports.object({}).strict()),
  command("listProviderSessionsForTask", external_exports.object({ taskId: identifier5 }).strict()),
  command("getSession", external_exports.object({ id: sessionId4 }).strict()),
  command("listSessionStatuses", external_exports.object({ sessionIds: external_exports.array(sessionId4).min(1).max(200) }).strict()),
  command("findByProviderSessionId", external_exports.object({ provider: external_exports.string().min(1), providerSessionId: external_exports.string().min(1) }).strict()),
  command("findLatestResumableForTask", external_exports.object({ taskId: identifier5, provider: external_exports.string().min(1) }).strict()),
  command("listPersistedSessions", external_exports.object({ afterId: identifier5.optional() }).strict()),
  command("listActiveRootSessions", external_exports.object({ afterId: sessionId4.optional(), limit: external_exports.number().int().min(1).max(200) }).strict()),
  command("listSessionHierarchy", external_exports.object({ afterId: sessionId4.optional(), limit: external_exports.number().int().min(1).max(200) }).strict()),
  command("listClaimedProviderSessionIds", external_exports.object({ provider: external_exports.string().min(1), excludeSessionId: sessionId4 }).strict()),
  command("listProjectSessions", external_exports.object({ sessionId: sessionId4, limit: external_exports.number().int().positive().max(500).optional() }).strict()),
  command("reconfigure", sessionCas.extend({ provider: external_exports.string().min(1), providerSessionId: external_exports.string().min(1).nullable(), launchProjectPath: text2.optional(), launchModel: text2.optional(), launchEffort: text2.optional(), permissionMode: text2.optional() }).strict()),
  command("reopenForResume", sessionCas.extend({ provider: external_exports.string().min(1).optional(), providerSessionId: external_exports.string().min(1).optional() }).strict()),
  command("bindPty", sessionCas.extend({ provider: external_exports.string().min(1).optional(), providerSessionId: external_exports.string().min(1).optional() }).strict()),
  command("markClosed", sessionCas.strict()),
  command("markFailed", sessionCas.extend({ errorCode: external_exports.string().min(1) }).strict()),
  command("setSnapshotRef", sessionCas.extend({ ref: snapshotRef }).strict()),
  command("setSessionTitleFallbackIfNull", external_exports.object({ sessionId: sessionId4, titleFallback: external_exports.string().max(512) }).strict()),
  command("resolveTask", external_exports.object({ ref: punchRef }).strict()),
  command("resolveSession", external_exports.object({ ref: punchRef, taskId: identifier5 }).strict()),
  command("readTaskName", external_exports.object({ taskId: identifier5 }).strict()),
  command("createLocalSubtask", punchStart.strict()),
  command("updateOpenWorkflowPunchDerivedFields", workflowPunchDerivedUpdate),
  command("recordLocalOneshot", punchStart.extend({ endedAtMs: integer3, durationHours: external_exports.number().finite().nonnegative().nullable().optional(), durationMs: integer3.nullable().optional(), description: text2.optional() }).strict()),
  command("settleLocalSubtask", external_exports.object({ punchId: identifier5, taskId: identifier5, sessionId: identifier5, endedAtMs: integer3, durationHours: external_exports.number().finite().nonnegative().nullable().optional(), durationMs: integer3.nullable().optional(), description: text2.optional(), name: text2.optional(), identitySnapshot: punchIdentity, assignee: punchAssignee, usage: punchUsage, at: integer3.optional() }).strict()),
  command("settleOrphanPunch", external_exports.object({ taskId: identifier5, punchId: identifier5, endedAtMs: integer3.nullable(), durationHours: external_exports.number().finite().nonnegative().nullable(), endSource: external_exports.string().min(1), at: integer3.optional() }).strict()),
  command("reconcilePunchIdentity", external_exports.object({ taskId: identifier5, sessionId: identifier5, punchId: identifier5, identitySnapshot: external_exports.record(external_exports.unknown()), onlyIfMissing: external_exports.boolean().optional(), at: integer3.optional() }).strict()),
  command("resolveConversationWorkSessions", external_exports.object({ sessionIds: external_exports.array(sessionId4).max(512) }).strict()),
  command("queryPunchesForTask", external_exports.object({ taskId: identifier5, cli: external_exports.string().optional(), limit: external_exports.number().int().nonnegative().max(5e3).optional(), offset: external_exports.number().int().nonnegative().max(5e3).optional(), includeTokenPrice: external_exports.boolean().optional(), ...punchListCursorInput }).strict()),
  command("listPunchesForTasks", external_exports.object({ taskIds: external_exports.array(identifier5).max(1e3), limit: external_exports.number().int().nonnegative().max(5e3), ...punchListCursorInput }).strict()),
  command("listAllPunches", external_exports.object({ limit: external_exports.number().int().nonnegative().max(5e3).optional(), ...punchListCursorInput }).strict()),
  command("findPunchById", external_exports.object({ taskId: identifier5, punchId: identifier5 }).strict()),
  command("findPunchByRequestId", external_exports.object({ sourceSessionId: sessionId4, ownerSessionId: sessionId4, batchId: external_exports.string().regex(/^[0-9a-f]{64}$/u), requestId: external_exports.string().regex(/^[0-9a-f]{64}$/u) }).strict()),
  command("listUnpricedPunchModels", external_exports.object({}).strict()),
  command("listOpen", external_exports.object({ sessionId: sessionId4 }).strict()),
  command("visitOpen", external_exports.object({ sessionId: sessionId4, afterStartedAtMs: integer3.optional(), afterId: identifier5.optional(), limit: external_exports.number().int().positive().max(128).optional() }).strict()),
  command("countOpen", external_exports.object({ sessionId: sessionId4 }).strict()),
  command("minOpenStartedAtMs", external_exports.object({ sessionId: sessionId4, beforeMs: integer3, coverage: external_exports.object({ floorMs: integer3, coveredMs: integer3 }).strict().nullable().optional() }).strict()),
  command("hasAmbiguousOpenPunch", external_exports.object({ sessionId: sessionId4, excludePunchId: identifier5, punchType: external_exports.string(), afterId: identifier5.optional() }).strict()),
  command("preloadDoneKeys", external_exports.object({ sessionId: sessionId4 }).strict()),
  command("listSettledRoundStarts", external_exports.object({ taskId: identifier5, providerSessionId: external_exports.string().min(1) }).strict()),
  command("wasPunched", external_exports.object({ taskId: identifier5, punchId: identifier5 }).strict()),
  command("readPunchStartedAt", external_exports.object({ taskId: identifier5, punchId: identifier5 }).strict()),
  command("listRecoverableBindings", external_exports.object({}).strict()),
  command("visitRecoverableBindings", external_exports.object({}).strict()),
  command("readPunchSinceMs", external_exports.object({ sessionId: sessionId4, providerSessionId: external_exports.string().min(1) }).strict()),
  command("readPunchWindow", external_exports.object({ taskId: identifier5, punchId: identifier5 }).strict()),
  command("listOpenPunchesForSettlement", external_exports.object({ sessionId: identifier5.optional(), afterStartedAtMs: integer3.optional(), afterId: identifier5.optional(), limit: external_exports.number().int().positive().max(200) }).strict()),
  command("commitConversationWork", commitConversationWorkInput),
  command("recordFreshTeamSession", external_exports.object({ sessionId: sessionId4, usedAtMs: integer3 }).strict()),
  command("listRecentTeamUsage", external_exports.object({ windowDays: external_exports.number().int().positive().max(Math.floor(Number.MAX_SAFE_INTEGER / 864e5)), nowMs: integer3 }).strict()),
  command("pluginDirectoryProjects", CorePluginHostDirectoryProjectsInputSchema),
  command("pluginSettledWorkChunk", CorePluginHostSettledWorkChunkInputSchema),
  command("ensurePluginSubagentExportActivation", CorePluginHostSubagentExportActivationInputSchema),
  command("getTaskSessionBinding", external_exports.object({ taskId: identifier5 }).strict()),
  command("listActiveTaskSessionBindings", external_exports.object({ provider: taskSessionProvider.nullable() }).strict()),
  command("getActiveTaskSessionProjectPath", external_exports.object({ taskId: identifier5 }).strict()),
  command("setActiveTaskSessionBinding", external_exports.object({
    taskId: identifier5,
    provider: taskSessionProvider,
    providerSessionId: taskSessionNativeId,
    projectPath: external_exports.string().max(4096).nullable(),
    label: external_exports.string().max(512).nullable(),
    at: integer3
  }).strict())
]);
var failure = external_exports.object({ status: external_exports.enum(["stale", "missing", "deleted", "conflict"]), currentRevision: counter2.optional() }).strict();
var unsupported = external_exports.object({ status: external_exports.literal("unsupported"), reason: external_exports.literal("null-task-origin-unrepresentable") }).strict();
var outcome = (row) => external_exports.union([external_exports.object({ status: external_exports.literal("updated"), value: row }).strict(), failure]);
var punchReferenceResult = external_exports.union([
  external_exports.object({ status: external_exports.literal("ok"), value: external_exports.object({ id: identifier5, sourceKey: external_exports.string() }).strict() }).strict(),
  external_exports.object({ status: external_exports.enum(["missing", "collision", "cross_task", "cross_project", "invalid", "closed", "unavailable"]), error: external_exports.string() }).strict()
]);
var monitorRecoveryBinding = external_exports.object({ sessionId: sessionId4, taskId: sessionId4.nullable(), provider: text2, providerSessionId: text2, projectPath: text2, sourceRef: text2, checkpointSinceMs: integer3.nullable(), revision: counterText }).strict();
var folderResult = external_exports.union([
  external_exports.object({ status: external_exports.literal("ok"), value: external_exports.array(external_exports.string()) }).strict(),
  external_exports.object({ status: external_exports.literal("missing"), error: external_exports.literal("missing") }).strict()
]);
var CoreWorkNativeDeletionReplySchema = external_exports.union([external_exports.object({ status: external_exports.literal("ok"), value: external_exports.object({ id: identifier5 }).strict() }).strict(), external_exports.object({ status: external_exports.enum(["missing", "collision"]), error: external_exports.enum(["missing", "collision"]) }).strict()]).refine((value) => value.status === "ok" || value.status === value.error);
var deletionReply = CoreWorkNativeDeletionReplySchema;
var CoreWorkValueSchemas = {
  countConversationBoard: ConversationBoardCountsSchema,
  pageConversationBoard: ConversationBoardPageSchema,
  pageConversationBoardInventory: ConversationBoardInventoryPageSchema,
  pageConversationBoardUnlinkedSessions: ConversationBoardUnlinkedPageSchema,
  pageConversationBoardTaskLookupIssues: ConversationBoardUnlinkedPageSchema,
  pageConversationBoardSessions: ConversationBoardSessionsSchema,
  deleteProject: deletionReply,
  deleteMilestone: deletionReply,
  pageProjects: pageReply(nativeProject),
  pageMilestones: pageReply(milestone),
  pageTasks: pageReply(nativeTask),
  projectTaskSummary: CoreWorkProjectTaskSummarySchema,
  pageProjectTaskStats: CoreWorkProjectTaskStatsPageSchema,
  listProjectsByFolder: pageReply(nativeProject),
  getNativeTask: nativeTask.nullable(),
  getMilestone: milestone.nullable(),
  findTaskBySessionId: external_exports.union([external_exports.object({ status: external_exports.literal("ok"), value: nativeTask.nullable() }).strict(), external_exports.object({ status: external_exports.literal("ambiguous"), error: external_exports.literal("ambiguous") }).strict()]),
  listProjectFolders: folderResult,
  linkProjectFolder: folderResult,
  unlinkProjectFolder: folderResult,
  listUsedFolders: external_exports.array(external_exports.object({ folderPath: external_exports.string(), lastUsedAtMs: integer3.nullable() }).strict()),
  recordFreshTeamSession: external_exports.boolean(),
  listRecentTeamUsage: external_exports.array(external_exports.object({ teamKey: external_exports.string(), recentCount: integer3 }).strict()),
  pluginDirectoryProjects: CorePluginHostDirectoryProjectsSchema,
  pluginSettledWorkChunk: CorePluginHostSettledWorkChunkSchema,
  ensurePluginSubagentExportActivation: CorePluginHostSubagentExportActivationSchema,
  getTaskSessionBinding: taskSessionBinding.nullable(),
  listActiveTaskSessionBindings: external_exports.array(taskSessionActiveBinding),
  getActiveTaskSessionProjectPath: external_exports.string().max(4096).nullable(),
  setActiveTaskSessionBinding: external_exports.union([
    external_exports.object({ status: external_exports.literal("updated"), value: taskSessionBinding }).strict(),
    external_exports.object({ status: external_exports.enum(["missing", "deleted", "conflict"]) }).strict()
  ]),
  listProjects: external_exports.array(project),
  getProject: project.nullable(),
  createProject: project,
  updateProject: outcome(project),
  archiveProject: outcome(project),
  listMilestones: external_exports.array(milestone),
  createMilestone: milestone,
  updateMilestone: outcome(milestone),
  archiveMilestone: outcome(milestone),
  listTasks: external_exports.array(task),
  getTask: task.nullable(),
  createTask: external_exports.union([task, unsupported]),
  updateTask: external_exports.union([outcome(task), unsupported]),
  archiveTask: outcome(task),
  softDeleteTask: outcome(task),
  createOrAdoptSession: sessionOutcome(CoreWorkSessionSchema),
  createDraftSession: CoreWorkSessionSchema,
  ensureUnassignedSessionTasks: external_exports.object({ prepared: integer3, hasMore: external_exports.boolean(), pending: integer3 }).strict(),
  bindTaskSession: sessionOutcome(CoreWorkSessionSchema.nullable()),
  advanceRunGeneration: external_exports.union([external_exports.object({ status: external_exports.literal("updated"), value: external_exports.object({ revision: sessionRevision, runGeneration: sessionRevision }).strict() }).strict(), sessionFailure]),
  setMonitorIntent: sessionOutcome(CoreWorkSessionSchema),
  setMonitorStatusFamily: external_exports.object({ status: external_exports.enum(["updated", "unchanged", "stale"]), changed: external_exports.number().int().nonnegative() }).strict(),
  listMonitorRoster: external_exports.object({ rows: external_exports.array(MonitorRosterRowSchema), nextAfterId: sessionId4.nullable() }).strict(),
  listSessionFamilies: external_exports.object({ rows: external_exports.array(MonitorFamilyRowSchema), nextAfterId: sessionId4.nullable() }).strict(),
  listMonitorReconcileCandidates: external_exports.object({ rows: external_exports.array(MonitorFamilyRowBaseSchema), nextAfterId: sessionId4.nullable() }).strict(),
  commitObservedState: external_exports.object({ status: external_exports.enum(["updated", "unchanged", "blocked", "stale"]), observedState: ObservedStateSchema.nullable(), errorKind: ObservedErrorKindSchema.nullable() }).strict(),
  acknowledgeObservedCompletion: external_exports.object({ acknowledged: external_exports.boolean() }).strict(),
  getObservedState: external_exports.object({ observedState: ObservedStateSchema, errorKind: ObservedErrorKindSchema.nullable(), taskId: sessionId4.nullable(), provider: text2, providerSessionId: text2, status: external_exports.string() }).strict().nullable(),
  resetStaleObservedStates: external_exports.object({ changed: external_exports.number().int().nonnegative() }).strict(),
  monitorProjectorLease: external_exports.object({ status: external_exports.enum(["granted", "denied", "held", "lost", "released"]) }).strict(),
  listMonitorRecoveryCandidates: external_exports.array(external_exports.object({ session: CoreWorkSessionSchema, state: external_exports.literal("pending"), reason: external_exports.literal("live-source-unverified") }).strict()),
  listProviderSessionsForTask: external_exports.array(CoreWorkSessionSchema),
  getSession: CoreWorkSessionSchema.nullable(),
  listSessionStatuses: external_exports.object({ rows: external_exports.array(external_exports.object({ sessionId: sessionId4, status: external_exports.string() }).strict()) }).strict(),
  findByProviderSessionId: CoreWorkSessionSchema.nullable(),
  findLatestResumableForTask: CoreWorkSessionSchema.nullable(),
  listPersistedSessions: external_exports.array(CoreWorkSessionSchema),
  listActiveRootSessions: external_exports.object({ rows: external_exports.array(CoreWorkSessionSchema), nextAfterId: sessionId4.nullable() }).strict(),
  listSessionHierarchy: external_exports.object({ rows: external_exports.array(CoreWorkSessionHierarchyRowSchema), nextAfterId: sessionId4.nullable() }).strict(),
  listClaimedProviderSessionIds: external_exports.array(external_exports.string()),
  listProjectSessions: external_exports.union([external_exports.object({ currentProviderSessionId: text2, currentTaskId: identifier5.nullable(), items: external_exports.array(external_exports.object({ providerSessionId: external_exports.string(), taskId: identifier5.nullable(), title: text2, createdAt: integer3, updatedAt: integer3, active: external_exports.boolean() }).strict()) }).strict(), external_exports.null()]),
  reconfigure: identityOutcome,
  reopenForResume: resumeOutcome,
  bindPty: identityOutcome,
  markClosed: identityOutcome,
  markFailed: identityOutcome,
  setSnapshotRef: identityOutcome,
  setSessionTitleFallbackIfNull: external_exports.object({ written: external_exports.boolean() }).strict(),
  resolveTask: punchReferenceResult,
  resolveSession: punchReferenceResult,
  readTaskName: external_exports.string().nullable(),
  createLocalSubtask: punchWriteOutcome,
  updateOpenWorkflowPunchDerivedFields: workflowPunchDerivedOutcome,
  recordLocalOneshot: punchWriteOutcome,
  settleLocalSubtask: punchWriteOutcome,
  settleOrphanPunch: punchWriteOutcome,
  reconcilePunchIdentity: external_exports.boolean(),
  resolveConversationWorkSessions: external_exports.array(external_exports.object({ sessionId: sessionId4, taskId: sessionId4, provider: external_exports.enum(["claude", "codex"]) }).strict()),
  queryPunchesForTask: external_exports.object({ rows: external_exports.array(CoreNativePunchRowSchema), snapshot: external_exports.unknown().nullable(), tokenPrice: external_exports.unknown().nullable(), nextCursor: CorePunchListCursorSchema.nullable() }).strict(),
  listPunchesForTasks: external_exports.object({ rows: external_exports.array(CoreNativePunchRowSchema), nextCursor: CorePunchListCursorSchema.nullable() }).strict(),
  listAllPunches: external_exports.object({ rows: external_exports.array(CoreNativePunchRowSchema), nextCursor: CorePunchListCursorSchema.nullable() }).strict(),
  findPunchById: CoreNativePunchRowSchema.nullable(),
  findPunchByRequestId: CoreNativePunchRowSchema.nullable(),
  listUnpricedPunchModels: external_exports.array(external_exports.object({ provider: external_exports.string(), model: external_exports.string(), punches: integer3 }).strict()),
  listOpen: external_exports.array(CoreNativePunchRowSchema).max(128),
  visitOpen: external_exports.array(CoreNativePunchRowSchema).max(128),
  countOpen: integer3,
  minOpenStartedAtMs: integer3.nullable(),
  hasAmbiguousOpenPunch: external_exports.boolean(),
  preloadDoneKeys: external_exports.array(external_exports.string()),
  listSettledRoundStarts: external_exports.array(integer3),
  wasPunched: external_exports.boolean(),
  readPunchStartedAt: integer3.nullable(),
  listRecoverableBindings: external_exports.array(monitorRecoveryBinding).max(128),
  visitRecoverableBindings: external_exports.array(monitorRecoveryBinding).max(128),
  readPunchSinceMs: integer3.nullable(),
  readPunchWindow: external_exports.object({ sessionId: sessionId4, startedAtMs: integer3, endedAtMs: integer3.nullable(), sourceNativeSessionId: text2 }).strict().nullable(),
  listOpenPunchesForSettlement: external_exports.array(CoreOpenPunchSettlementRowSchema).max(200),
  commitConversationWork: external_exports.object({ status: external_exports.enum(["committed", "no-change"]), operationId: external_exports.string(), affectedSessionIds: external_exports.array(sessionId4).max(100), changedPunchIds: external_exports.array(sessionId4).max(100), manualChanges: external_exports.array(manualPunchChange).max(100) }).strict()
};
var CoreWorkFailureSchema = external_exports.object({ ok: external_exports.literal(false), errorCode: external_exports.enum(["work_input_invalid", "work_row_invalid", "work_response_too_large", "work_database_unavailable", "work_clock_invalid"]) }).strict();

var nativeSecretKeys_default = {
  version: 1,
  legacyPrefix: "v2:native:secret:",
  entries: [
    {
      logical: "account.refreshToken",
      legacySourceKey: "account:cognito.refreshToken",
      legacyId: "native-secret:account:cognito.refreshToken",
      current: "secret:account:cognito.refreshToken",
      disposition: "fold:account-vault"
    },
    {
      logical: "pm.teamupquick",
      legacySourceKey: "pm:teamupquick",
      legacyId: "native-secret:pm:teamupquick",
      current: "secret:pm:teamupquick",
      disposition: "map"
    },
    {
      logical: "pm.linear",
      legacySourceKey: "pm:linear",
      legacyId: "native-secret:pm:linear",
      current: "secret:pm:linear",
      disposition: "map"
    },
    {
      logical: "pm.clickup",
      legacySourceKey: "pm:clickup",
      legacyId: "native-secret:pm:clickup",
      current: "secret:pm:clickup",
      disposition: "map"
    },
    {
      logical: "pm.trello",
      legacySourceKey: "pm:trello",
      legacyId: "native-secret:pm:trello",
      current: "secret:pm:trello",
      disposition: "map"
    },
    {
      logical: "pm.asana",
      legacySourceKey: "pm:asana",
      legacyId: "native-secret:pm:asana",
      current: "secret:pm:asana",
      disposition: "map"
    },
    {
      logical: "pm.notion",
      legacySourceKey: "pm:notion",
      legacyId: "native-secret:pm:notion",
      current: "secret:pm:notion",
      disposition: "map"
    },
    {
      logical: "pm.monday",
      legacySourceKey: "pm:monday",
      legacyId: "native-secret:pm:monday",
      current: "secret:pm:monday",
      disposition: "map"
    },
    {
      logical: "chatops.credential.telegram",
      legacySourceKey: "chatops:credential:telegram:bundle",
      legacyId: "native-secret:chatops-credential:telegram:bundle",
      current: "secret:chatops:credential:telegram",
      disposition: "map"
    },
    {
      logical: "chatops.credential.discord",
      legacySourceKey: "chatops:credential:discord:bundle",
      legacyId: "native-secret:chatops-credential:discord:bundle",
      current: "secret:chatops:credential:discord",
      disposition: "map"
    },
    {
      logical: "chatops.credential.line",
      legacySourceKey: "chatops:credential:line:bundle",
      legacyId: "native-secret:chatops-credential:line:bundle",
      current: "secret:chatops:credential:line",
      disposition: "map"
    },
    {
      logical: "chatops.credentialRevision.telegram",
      legacySourceKey: "chatops:credential:telegram:revision",
      legacyId: "native-secret:chatops-credential:telegram:revision",
      current: "secret:chatops:credential:telegram:revision",
      disposition: "fold:chatops-revision"
    },
    {
      logical: "chatops.credentialRevision.discord",
      legacySourceKey: "chatops:credential:discord:revision",
      legacyId: "native-secret:chatops-credential:discord:revision",
      current: "secret:chatops:credential:discord:revision",
      disposition: "fold:chatops-revision"
    },
    {
      logical: "chatops.credentialRevision.line",
      legacySourceKey: "chatops:credential:line:revision",
      legacyId: "native-secret:chatops-credential:line:revision",
      current: "secret:chatops:credential:line:revision",
      disposition: "fold:chatops-revision"
    },
    {
      logical: "chatops.bindingCodePepper",
      legacySourceKey: "chatops:binding-code:pepper:v1",
      legacyId: "native-secret:chatops-binding-code-pepper-v1",
      current: null,
      disposition: "drop"
    },
    {
      logical: "apiKeyPepper",
      legacySourceKey: "api-key-pepper",
      legacyId: "native-secret:api-key-pepper",
      current: null,
      disposition: "drop"
    },
    {
      logical: "localserver.passwordHash",
      legacySourceKey: "localserver.passwordHash",
      legacyId: "native-secret:localserver.passwordHash",
      current: "secret:localserver:passwordHash",
      disposition: "map"
    },
    {
      logical: "localserver.portal_url_v1",
      legacySourceKey: "localserver.portal_url_v1",
      legacyId: "native-secret:localserver.portal_url_v1",
      current: "secret:localserver:portal_url_v1",
      disposition: "map"
    },
    {
      logical: "localserver.namedTunnelToken",
      legacySourceKey: "localserver.namedTunnelToken",
      legacyId: "native-secret:localserver.namedTunnelToken",
      current: "secret:localserver:namedTunnelToken",
      disposition: "map"
    },
    {
      logical: "localserver.cfReadToken",
      legacySourceKey: "localserver.cfReadToken",
      legacyId: "native-secret:localserver.cfReadToken",
      current: "secret:localserver:cfReadToken",
      disposition: "map"
    },
    {
      logical: "localserver.hostedTunnelManageSecret",
      legacySourceKey: "localserver.hostedTunnelManageSecret",
      legacyId: "native-secret:localserver.hostedTunnelManageSecret",
      current: "secret:localserver:hostedTunnelManageSecret",
      disposition: "map"
    },
    {
      logical: "portal.bindProofKey",
      legacySourceKey: "portalBindProofKey",
      legacyId: "native-secret:portalBindProofKey",
      current: "secret:portal:bindProofKey",
      disposition: "map"
    },
    {
      logical: "webCwd",
      legacySourceKey: "web-cwd",
      legacyId: "native-secret:web-cwd",
      current: null,
      disposition: "drop"
    },
    {
      logical: "nativeHttpToken",
      legacySourceKey: "native-http-token",
      legacyId: "native-secret:native-http-token",
      current: null,
      disposition: "drop"
    }
  ]
};

var NATIVE_SECRET_LEGACY_PREFIX = nativeSecretKeys_default.legacyPrefix;
var NATIVE_SECRET_KEY_ENTRIES = nativeSecretKeys_default.entries;
var byLegacy = new Map(NATIVE_SECRET_KEY_ENTRIES.map((entry2) => [`${NATIVE_SECRET_LEGACY_PREFIX}${entry2.legacySourceKey}`, entry2]));
var byCurrent = new Map(NATIVE_SECRET_KEY_ENTRIES.filter((entry2) => entry2.current !== null).map((entry2) => [entry2.current, entry2]));

var revision2 = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var hash = external_exports.string().regex(/^[a-f0-9]{64}$/u);
var id3 = external_exports.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u);
var metadata = external_exports.object({ runId: id3, sourceSnapshotHash: hash, sourceIdentityDigest: hash, mappingVersion: id3.max(64), sourceRevision: id3, privacyPolicyDigest: hash }).strict();
var backup = external_exports.object({ backupId: id3, digest: hash, sourceIdentityDigest: hash }).strict();
var privacyRow = external_exports.object({ subjectKind: external_exports.literal("session"), subjectKey: external_exports.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_.~:%-]*$/u), reason: external_exports.enum(["chatops-cred-write", "binding-create-code", "static-console"]), markedAt: revision2 }).strict();
var command2 = (operation, input) => external_exports.object({ operation: external_exports.literal(operation), input }).strict();
function settingsImportCommands(entry2) {
  return [
    command2("importBeginApply", external_exports.object({ metadata, expectedRevision: revision2, at: revision2 }).strict()),
    command2("importMarkBackupReady", external_exports.object({ metadata, backup, at: revision2 }).strict()),
    command2("importMarkBlocked", external_exports.object({ runId: id3, reason: external_exports.string().min(1).max(128), at: revision2 }).strict()),
    command2("importApplyAtomically", external_exports.object({ import: metadata.extend({ settings: external_exports.array(entry2).max(4096), privacyRows: external_exports.array(privacyRow).max(4096), privacySourceRevision: id3, backup, secretParity: external_exports.enum(["verified", "not_verified", "failed"]), pendingHandoffs: revision2, expectedActivationRevision: revision2 }).strict(), at: revision2 }).strict())
  ];
}

function boundedJson(value) {
  const seen = /* @__PURE__ */ new Set();
  const check = (item, depth) => {
    if (depth > 16) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || seen.has(item)) return false;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
    seen.add(item);
    const valid = Object.values(item).every((child) => check(child, depth + 1)) && (!Array.isArray(item) || Object.keys(item).length === item.length);
    seen.delete(item);
    return valid;
  };
  try {
    return check(value, 0) && new TextEncoder().encode(JSON.stringify(value)).length <= 65536;
  } catch {
    return false;
  }
}
var revision3 = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var key2 = external_exports.string().max(256);
var expectedRevision = revision3.nullable().optional();
var read = external_exports.object({ key: key2, expectedRevision }).strict();
var entry = external_exports.object({ key: key2, value: external_exports.unknown(), expectedRevision }).strict().refine((value) => Object.hasOwn(value, "value") && boundedJson(value.value));
var write = external_exports.object({ key: key2, value: external_exports.unknown(), expectedRevision, at: revision3 }).strict().refine((value) => Object.hasOwn(value, "value") && boundedJson(value.value));
var secret = external_exports.object({ sourceKey: key2, cipherHex: external_exports.string().min(2).max(524288).regex(/^(?:[a-fA-F0-9]{2})+$/u), secretFormat: external_exports.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/u), expectedRevision }).strict();
var origin = external_exports.enum(["fresh", "sqlite"]);
var startupRevision = external_exports.object({ installId: revision3.nullable(), flagOverrides: revision3.nullable() }).strict();
var flags = external_exports.record(external_exports.string().min(12).max(128).regex(/^TUQ_ENABLE_[A-Z0-9_]+$/u), external_exports.boolean()).refine((value) => Object.keys(value).length <= 128);
var installId2 = external_exports.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
var command3 = (operation, input) => external_exports.object({ operation: external_exports.literal(operation), input }).strict();
var CoreSettingsCommandSchema = external_exports.discriminatedUnion("operation", [
  ...settingsImportCommands(entry),
  command3("read", read),
  command3("readBundle", external_exports.object({ keys: external_exports.array(key2).max(32), expectedRevisions: external_exports.array(revision3.nullable()).max(32).optional(), expectedRevisionChecks: external_exports.array(external_exports.boolean()).max(32).optional() }).strict().refine((value) => (value.expectedRevisions === void 0 || value.expectedRevisions.length === value.keys.length) && (value.expectedRevisionChecks === void 0 || value.expectedRevisions !== void 0 && value.expectedRevisionChecks.length === value.keys.length))),
  command3("write", write),
  command3("writeBundle", external_exports.object({ settings: external_exports.array(entry).max(32), secrets: external_exports.array(secret).max(32).optional(), at: revision3 }).strict().refine((value) => value.settings.length + (value.secrets?.length ?? 0) > 0 && value.settings.length + (value.secrets?.length ?? 0) <= 32)),
  command3("delete", read),
  command3("writeApiFlags", write),
  command3("writeApiFlagsBundle", external_exports.object({ settings: external_exports.array(external_exports.object({ key: external_exports.enum(["api_enabled", "api_dispatch_enabled"]), value: external_exports.object({ enabled: external_exports.boolean() }).strict(), expectedRevision }).strict()).min(1).max(2), at: revision3 }).strict()),
  command3("writeWebCwd", write),
  command3("readSecretCipher", external_exports.object({ sourceKey: key2 }).strict()),
  command3("readPreservedSecretCipher", external_exports.object({ sourceKey: key2, storageKind: external_exports.literal("cipher_blob"), secretFormat: secret.shape.secretFormat, keyVersion: external_exports.literal(1), revision: revision3.min(1) }).strict()),
  command3("readSecretMetadata", external_exports.object({ sourceKey: key2 }).strict()),
  command3("writeSecretCipher", secret.extend({ at: revision3 })),
  command3("deleteSecret", external_exports.object({ sourceKey: key2, expectedRevision }).strict()),
  command3("readActivation", external_exports.object({}).strict()),
  command3("isPublicReadActive", external_exports.object({}).strict()),
  command3("readFrozenSnapshot", external_exports.object({}).strict()),
  command3("isLocalAuthorityAvailable", external_exports.object({}).strict()),
  command3("readStartupSnapshot", external_exports.object({ origin }).strict()),
  command3("initializeFresh", external_exports.object({ origin, proof: external_exports.object({ kind: external_exports.literal("fresh-v2"), v1SourceAbsent: external_exports.literal(true) }).strict(), generatedInstallId: installId2, at: revision3 }).strict()),
  command3("writeMissingFromLegacy", external_exports.object({ origin, expectedInstallId: installId2, flagOverrides: flags, expectedRevision: startupRevision, at: revision3 }).strict())
]);
var readResult = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("found"), key: key2, value: external_exports.unknown(), revision: revision3, sourceKey: external_exports.string() }).strict(),
  external_exports.object({ status: external_exports.literal("missing") }).strict(),
  external_exports.object({ status: external_exports.literal("invalid"), reason: external_exports.literal("native-setting-json-invalid"), revision: revision3 }).strict(),
  external_exports.object({ status: external_exports.literal("unavailable"), reason: external_exports.string().min(1).max(128) }).strict(),
  external_exports.object({ status: external_exports.literal("blocked"), reason: external_exports.string().min(1).max(128) }).strict()
]);
var writeResult = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("updated"), revision: revision3 }).strict(),
  external_exports.object({ status: external_exports.literal("conflict"), revision: revision3.nullable() }).strict(),
  external_exports.object({ status: external_exports.literal("rejected"), reason: external_exports.string().min(1).max(128) }).strict(),
  external_exports.object({ status: external_exports.literal("unavailable"), reason: external_exports.string().min(1).max(128) }).strict()
]);
var failure2 = external_exports.object({ ok: external_exports.literal(false), errorCode: external_exports.enum(["settings_input_invalid", "settings_row_invalid", "settings_database_unavailable", "settings_result_too_large"]) }).strict();
var reason2 = external_exports.string().min(1).max(128);
var metadata2 = external_exports.object({ sourceKey: key2, storageKind: external_exports.literal("cipher_blob"), secretFormat: external_exports.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/u), keyVersion: external_exports.literal(1), revision: revision3.min(1) }).strict();
var hash2 = external_exports.string().regex(/^[a-f0-9]{64}$/u).nullable();
var proofId = external_exports.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u).nullable();
var activation = external_exports.object({ state: external_exports.enum(["staged", "ready", "active", "blocked"]), revision: revision3, manifestHash: hash2, sourceSnapshotHash: hash2, secretParity: external_exports.enum(["verified", "not_verified", "failed"]), reason: external_exports.string().nullable(), runId: proofId.optional(), backupId: proofId.optional(), backupDigest: hash2.optional(), mappingVersion: external_exports.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u).nullable().optional(), sourceRevision: proofId.optional(), privacyPolicyDigest: hash2.optional(), sourceIdentityDigest: hash2.optional(), sourcePrivacyDigest: hash2.optional() }).strict();
var snapshot = external_exports.object({ installId: installId2.nullable(), flagOverrides: flags.nullable(), revision: startupRevision }).strict().refine((value) => value.installId === null === (value.revision.installId === null) && value.flagOverrides === null === (value.revision.flagOverrides === null));
var startupFailure = external_exports.enum(["owner-unavailable", "row-invalid", "revision-conflict", "value-conflict", "write-failed"]);
var startupRead = external_exports.discriminatedUnion("status", [external_exports.object({ status: external_exports.literal("available"), value: snapshot }).strict(), external_exports.object({ status: external_exports.literal("unavailable"), reason: startupFailure }).strict()]);
var startupWrite = external_exports.discriminatedUnion("status", [external_exports.object({ status: external_exports.literal("written"), value: snapshot }).strict(), ...["conflict", "unavailable", "rejected"].map((status) => external_exports.object({ status: external_exports.literal(status), reason: startupFailure }).strict())]);

var identity = external_exports.string().regex(/^[1-9][0-9]{0,19}$/u).refine((value) => BigInt(value) <= 18446744073709551615n);
var CoreBackendScannerEndpointSchema = external_exports.union([
  external_exports.object({ host: external_exports.literal("127.0.0.1"), port: external_exports.number().int().min(1).max(65535), database: external_exports.literal("teamuq_main"), schema: external_exports.literal("public"), user: external_exports.literal("teamuq_scanner"), systemIdentifier: identity }).strict(),
  external_exports.object({ status: external_exports.literal("blocked"), reason: external_exports.string().regex(/^[a-z0-9_-]{1,80}$/u) }).strict()
]);

var text3 = external_exports.string().max(32768);
var CoreSessionInputSimilarityQuerySchema = external_exports.object({
  sessionId: external_exports.string().refine((value) => /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n),
  requestId: external_exports.string().min(1).max(512),
  processId: external_exports.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  generation: external_exports.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pairs: external_exports.array(external_exports.object({ expected: text3, observed: text3, allowEmpty: external_exports.literal(true).optional() }).strict()).min(1).max(16)
}).strict();
var CoreSessionInputSimilarityResultSchema = external_exports.object({
  status: external_exports.enum(["scored", "already_bound", "ineligible"]),
  scores: external_exports.array(external_exports.object({
    trigram: external_exports.number().min(0).max(1),
    string: external_exports.number().min(0).max(1).nullable()
  }).strict()).max(16)
}).strict();

var identifier6 = external_exports.string().refine((value) => /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n);
var integer4 = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var provider = external_exports.string().min(1).max(128);
var nativeSessionId = external_exports.string().min(1).max(512).refine((value) => value.trim() === value && value !== "codex-pending" && value !== "claude-pending" && !value.startsWith("codex:thread:") && !value.startsWith("claude:session:"));
var sourceRef = external_exports.string().min(1).max(4096).refine((value) => value.trim() === value);
var sessionCas2 = external_exports.object({
  status: external_exports.enum(["updated", "unchanged", "missing", "stale", "deleted", "conflict"]),
  session: CoreWorkSessionSchema.optional()
}).strict().refine((value) => (value.status === "updated" || value.status === "unchanged") === (value.session !== void 0));
var casOrSourceConflict = external_exports.union([
  sessionCas2,
  external_exports.object({ status: external_exports.literal("source_seed_conflict") }).strict()
]);
var command4 = (operation, input) => external_exports.object({ operation: external_exports.literal(operation), input }).strict();
var requestId4 = external_exports.string().min(1).max(512);
var requestHash = external_exports.string().regex(/^[a-f0-9]{64}$/u);
var requestCursor = external_exports.object({ queueRank: integer4, createdAtMs: integer4, id: identifier6 }).strict();
var requestRecord = external_exports.object({
  id: identifier6,
  createdAt: integer4,
  sessionId: identifier6,
  requestId: requestId4,
  body: external_exports.string().max(2 * 1024 * 1024),
  bodySha256: requestHash,
  firstInputIdentity: external_exports.null(),
  firstInputIdentityJson: external_exports.null(),
  attachments: external_exports.array(SessionRuntimeAttachmentSchema).max(32),
  autoEnter: external_exports.boolean(),
  state: external_exports.enum(["queued", "dispatching", "original_written", "enter_pending", "submitted", "delivered", "failed", "cancelled", "unknown"]),
  writeCertainty: external_exports.enum(["not_attempted", "not_written", "written", "unknown"]),
  queueRank: integer4,
  revision: integer4,
  originalAttempts: integer4,
  enterAttempts: integer4,
  boundProcessId: integer4.nullable(),
  boundGeneration: integer4.nullable(),
  boundRunGeneration: integer4.nullable(),
  boundRuntimeSessionId: external_exports.string().nullable(),
  claimOwner: external_exports.string().nullable(),
  claimRevision: integer4,
  errorCode: external_exports.string().nullable()
}).strict();
var requestMutation = external_exports.object({
  id: identifier6,
  sessionId: identifier6,
  expectedRevision: integer4
}).strict();
var requestClaim = requestMutation.extend({
  processId: integer4.refine((value) => value > 0),
  generation: integer4.refine((value) => value > 0),
  runGeneration: integer4.refine((value) => value > 0),
  now: integer4
}).strict();
var requestReceipt = external_exports.object({
  id: identifier6,
  sessionId: identifier6,
  revision: integer4,
  claimRevision: integer4.refine((value) => value > 0),
  processId: integer4.refine((value) => value > 0),
  generation: integer4.refine((value) => value > 0),
  runGeneration: integer4.refine((value) => value > 0),
  writeCertainty: external_exports.enum(["not_attempted", "not_written", "written", "unknown"]),
  errorCode: external_exports.string().max(256).nullable(),
  now: integer4
}).strict();
var sessionRequestMutation = external_exports.object({
  sessionId: identifier6,
  requestId: requestId4,
  expectedRevision: integer4,
  now: integer4
}).strict();
var recoveryProofFence = external_exports.object({
  commandId: identifier6,
  expectedRevision: integer4,
  requestId: requestId4,
  bodySha256: requestHash,
  state: external_exports.literal("delivered"),
  writeCertainty: external_exports.literal("written"),
  firstInputIdentityJson: external_exports.null()
}).strict();
var CoreSessionCommandSchema = external_exports.discriminatedUnion("operation", [
  command4("scoreInputCandidates", CoreSessionInputSimilarityQuerySchema),
  command4("readSessionIdentity", external_exports.object({ sessionId: identifier6 }).strict()),
  command4(
    "createPendingSession",
    external_exports.object({
      taskId: identifier6.nullable(),
      projectId: identifier6.nullable(),
      provider: provider.nullable(),
      providerSessionId: nativeSessionId.nullable(),
      providerSourceRef: sourceRef.nullable(),
      titleFallback: external_exports.string().max(512).nullable(),
      now: integer4
    }).strict().refine((value) => (value.providerSessionId === null || value.provider !== null) && (value.providerSourceRef === null || value.providerSessionId !== null))
  ),
  command4("resolveProviderSourceRefs", external_exports.object({
    keys: external_exports.array(external_exports.object({ provider, providerSessionId: external_exports.string().min(1).max(512) }).strict()).max(512)
  }).strict()),
  command4("bindProviderEvidence", external_exports.object({
    sessionId: identifier6,
    expectedRevision: integer4,
    provider: provider.optional(),
    providerSessionId: nativeSessionId,
    providerSourceRef: sourceRef.nullable(),
    runtimeSessionId: external_exports.string().min(1).max(512).refine((value) => value.trim() === value).nullable(),
    now: integer4
  }).strict()),
  command4("markIdentityRecoveryRequired", external_exports.object({
    sessionId: identifier6,
    expectedRevision: integer4,
    now: integer4
  }).strict()),
  command4("bindIdentityRecoverySource", external_exports.object({
    sessionId: identifier6,
    expectedRevision: integer4,
    taskId: identifier6.nullable(),
    provider,
    providerSessionId: nativeSessionId,
    providerSourceRef: sourceRef,
    projectPath: external_exports.string().min(1).max(4096).refine((value) => value.trim() === value),
    proofFence: recoveryProofFence.optional(),
    now: integer4
  }).strict()),
  command4("reconfigureSession", external_exports.object({
    sessionId: identifier6,
    expectedRevision: integer4,
    provider,
    providerSessionId: nativeSessionId.nullable(),
    providerSourceRef: sourceRef.nullable(),
    projectPath: external_exports.string().min(1).max(4096).refine((value) => value.trim() === value),
    launchOptions: external_exports.object({
      model: external_exports.string().min(1).max(512).refine((value) => value.trim() === value).nullable(),
      effort: external_exports.string().min(1).max(128).refine((value) => value.trim() === value).nullable(),
      permissionMode: external_exports.enum(["default", "acceptEdits", "plan", "max"])
    }).strict(),
    now: integer4
  }).strict()),
  command4("createInputRequest", external_exports.object({
    sessionId: identifier6,
    requestId: requestId4,
    body: external_exports.string().min(1).max(2 * 1024 * 1024),
    bodySha256: requestHash,
    attachments: external_exports.array(SessionRuntimeAttachmentSchema).max(32),
    autoEnter: external_exports.boolean(),
    now: integer4
  }).strict()),
  command4("getInputRequest", external_exports.object({ sessionId: identifier6, requestId: requestId4 }).strict()),
  command4("getInputRequestById", external_exports.object({ id: identifier6 }).strict()),
  command4("listInputRequests", external_exports.object({ sessionId: identifier6, limit: external_exports.number().int().min(1).max(128), cursor: requestCursor.nullable().optional() }).strict()),
  command4("claimInputRequest", requestClaim),
  command4("claimConversationInputRequest", requestMutation.extend({ now: integer4 }).strict()),
  command4("recordInputRequestOriginalResult", requestReceipt.extend({ accepted: external_exports.boolean() }).strict()),
  command4("recordInputRequestEnterResult", requestReceipt.extend({ enterNo: external_exports.number().int().min(1).max(3), delivered: external_exports.boolean(), finalEnter: external_exports.boolean().optional() }).strict()),
  command4("recordConversationInputRequestResult", external_exports.object({
    id: identifier6,
    sessionId: identifier6,
    revision: integer4,
    claimRevision: integer4.refine((value) => value > 0),
    outcome: external_exports.enum(["submitted", "delivered", "failed", "unknown"]),
    errorCode: external_exports.string().max(256).nullable(),
    now: integer4
  }).strict()),
  command4("editInputRequest", sessionRequestMutation.extend({ body: external_exports.string().min(1).max(2 * 1024 * 1024), bodySha256: requestHash }).strict()),
  command4("prioritizeInputRequest", sessionRequestMutation),
  command4("cancelInputRequest", sessionRequestMutation),
  command4("closeInputRequestsForSession", external_exports.object({ sessionId: identifier6, now: integer4 }).strict()),
  command4("recoverInputRequests", external_exports.object({ now: integer4 }).strict()),
  command4("listQueuedInputSessionIds", external_exports.object({ limit: integer4, afterSessionId: identifier6.optional() }).strict())
]);
var CORE_SESSION_OPERATIONS = Object.freeze(CoreSessionCommandSchema.options.map((option) => option.shape.operation.value));
var CoreSessionValueSchemas = {
  scoreInputCandidates: CoreSessionInputSimilarityResultSchema,
  readSessionIdentity: external_exports.object({ session: CoreWorkSessionSchema.nullable(), providerSourceRef: sourceRef.nullable() }).strict(),
  createPendingSession: external_exports.union([
    external_exports.object({ session: CoreWorkSessionSchema, providerSourceRef: sourceRef.nullable() }).strict(),
    external_exports.object({ status: external_exports.literal("source_seed_conflict") }).strict()
  ]),
  resolveProviderSourceRefs: external_exports.array(external_exports.object({
    sourceRef,
    status: external_exports.enum(["seed", "verified", "missing", "mismatch"])
  }).strict().nullable()),
  bindProviderEvidence: casOrSourceConflict,
  markIdentityRecoveryRequired: sessionCas2,
  bindIdentityRecoverySource: casOrSourceConflict,
  reconfigureSession: casOrSourceConflict,
  createInputRequest: external_exports.object({ kind: external_exports.enum(["created", "replay", "conflict"]), record: requestRecord }).strict(),
  getInputRequest: requestRecord.nullable(),
  getInputRequestById: requestRecord.nullable(),
  listInputRequests: external_exports.object({ items: external_exports.array(requestRecord), nextCursor: requestCursor.nullable() }).strict(),
  claimInputRequest: requestRecord.nullable(),
  claimConversationInputRequest: requestRecord.nullable(),
  recordInputRequestOriginalResult: requestRecord.nullable(),
  recordInputRequestEnterResult: requestRecord.nullable(),
  recordConversationInputRequestResult: requestRecord.nullable(),
  editInputRequest: requestRecord.nullable(),
  prioritizeInputRequest: requestRecord.nullable(),
  cancelInputRequest: requestRecord.nullable(),
  closeInputRequestsForSession: external_exports.null(),
  recoverInputRequests: external_exports.null(),
  listQueuedInputSessionIds: external_exports.array(identifier6)
};
var CoreSessionFailureSchema = external_exports.object({
  ok: external_exports.literal(false),
  errorCode: external_exports.enum([
    "session_input_invalid",
    "session_row_invalid",
    "session_identity_batch_too_large",
    "session_result_too_large",
    "session_operation_unsupported",
    "session_database_unavailable",
    "session_work_unavailable",
    "session_work_row_invalid"
  ])
}).strict();

var integer5 = external_exports.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
var provider2 = external_exports.enum(["telegram", "discord", "line"]);
var level = external_exports.enum(["read", "write", "dispatch"]);
var id4 = external_exports.string().regex(/^[1-9][0-9]{0,18}$/u).refine((value) => BigInt(value) <= 9223372036854775807n);
var cursor3 = external_exports.union([external_exports.literal("0"), id4]);
var cipherHex = external_exports.string().min(2).max(524288).regex(/^(?:[0-9a-f]{2})+$/u);
var key3 = external_exports.string().min(1).max(512);
var command5 = (operation, input) => external_exports.object({ operation: external_exports.literal(operation), input }).strict();
var CoreChatOpsCommandSchema = external_exports.discriminatedUnion("operation", [
  command5("readStatus", external_exports.object({}).strict()),
  command5("listBindings", external_exports.object({ afterId: cursor3, limit: integer5.min(1).max(128) }).strict()),
  command5("readBinding", external_exports.object({ provider: provider2, externalChatKey: key3 }).strict()),
  command5("readCredential", external_exports.object({ provider: provider2 }).strict()),
  command5("createBindingCode", external_exports.object({ now: integer5 }).strict()),
  command5("consumeBindingCode", external_exports.object({ provider: provider2, externalChatKey: key3, displayName: external_exports.string().max(512).nullable(), displayNameProvided: external_exports.boolean(), code: external_exports.string().max(165), now: integer5 }).strict()),
  command5("setCredential", external_exports.object({ provider: provider2, cipherHex, expectedRevision: integer5.nullable(), now: integer5 }).strict()),
  command5("clearCredential", external_exports.object({ provider: provider2, expectedRevision: integer5.nullable(), now: integer5 }).strict()),
  command5("revokeBinding", external_exports.object({ bindingId: id4, expectedGeneration: integer5.min(1), now: integer5 }).strict()),
  command5("setBindingLevel", external_exports.object({ bindingId: id4, level, expectedGeneration: integer5.min(1), now: integer5 }).strict())
]);
var binding = external_exports.object({ id: id4, provider: provider2, externalChatKey: key3, displayName: external_exports.string().max(512).nullable(), status: external_exports.enum(["active", "disabled", "revoked"]), level, generation: integer5.min(1), boundAt: integer5, lastSeenAt: integer5.nullable(), createdAtMs: integer5 }).strict();
var credential = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("missing"), settingRevision: integer5.nullable() }).strict(),
  external_exports.object({ status: external_exports.literal("present"), cipherHex, secretRevision: integer5.min(1), settingRevision: integer5.min(1) }).strict()
]);
var mutation = external_exports.discriminatedUnion("status", [
  external_exports.object({ status: external_exports.literal("updated"), settingRevision: integer5.min(1) }).strict(),
  external_exports.object({ status: external_exports.literal("conflict"), settingRevision: integer5.nullable() }).strict()
]);
var state = external_exports.object({ configured: external_exports.boolean(), revision: integer5.nullable() }).strict();
var CoreChatOpsValueSchemas = {
  readStatus: external_exports.object({ telegram: state, discord: state, line: state }).strict(),
  listBindings: external_exports.object({ rows: external_exports.array(binding).max(128), nextId: id4.nullable() }).strict(),
  readBinding: binding.nullable(),
  readCredential: credential,
  createBindingCode: external_exports.object({ code: external_exports.string().regex(/^C1\.[A-Za-z0-9_-]{8,32}\.[A-Za-z0-9_-]{16,128}$/u), expiresAtMs: integer5 }).strict(),
  consumeBindingCode: external_exports.union([external_exports.object({ status: external_exports.literal("consumed"), binding }).strict(), external_exports.object({ status: external_exports.enum(["invalid", "expired", "consumed", "locked", "wrong_attempt"]) }).strict()]),
  setCredential: mutation,
  clearCredential: mutation,
  revokeBinding: mutation,
  setBindingLevel: mutation
};
var CoreChatOpsFailureSchema = external_exports.object({ ok: external_exports.literal(false), errorCode: external_exports.enum(["chatops_input_invalid", "chatops_row_invalid", "chatops_database_unavailable", "chatops_credential_unavailable", "chatops_result_too_large"]) }).strict();

var identity2 = external_exports.string().min(1).max(512).refine((value) => value.trim().length > 0);
var integer6 = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var CoreNormalizedMonitorKeySchema = external_exports.object({
  providerId: identity2,
  providerSessionId: identity2,
  normalizationId: identity2
}).strict();
var CoreNormalizedMonitorRecordSchema = CoreNormalizedMonitorKeySchema.extend({
  normalizerRevision: identity2,
  observedAt: integer6,
  snapshot: external_exports.object({
    runState: external_exports.enum(["none", "idle", "running", "waiting", "completed", "error"]),
    sourceRevision: external_exports.string().min(1).max(16384),
    base: external_exports.enum(["busy", "idle"]).optional(),
    baseRevisionMs: integer6.optional(),
    turnId: identity2.optional(),
    conversationTitle: external_exports.string().max(4096).nullable().optional(),
    sourceDirective: external_exports.enum(["apply", "hold", "unavailable"]).optional(),
    diagnostic: external_exports.string().max(4096).optional()
  }).strict()
}).strict();

var counter3 = external_exports.string().refine((value) => /^(0|[1-9][0-9]{0,18})$/u.test(value) && BigInt(value) <= 9223372036854775807n);
var id5 = counter3.refine((value) => value !== "0");
var text4 = external_exports.string().nullable();
var number = counter3.nullable();
var bytes3 = external_exports.number().int().nonnegative().max(104857600);
var messageSource = external_exports.enum(["typed", "command", "tool_result", "meta", "interrupt", "notify", "compacted", "token_usage_record"]).nullable();
var CoreConversationSessionSnapshotSchema = external_exports.object({
  id: id5,
  revision: counter3,
  provider: text4,
  providerSessionId: text4,
  title: text4,
  indexState: external_exports.enum(["pending", "ready", "partial", "missing", "stale", "error", "unknown"]),
  subagentState: external_exports.enum(["none", "ready", "syncing"]),
  generation: number,
  parserRevision: text4,
  bindingRevision: text4,
  recordWatermark: number,
  byteWatermark: number,
  sourcePath: text4,
  sourceDev: text4,
  sourceIno: text4,
  sourceSize: number,
  sourceMtimeMs: number,
  lastErrorCode: text4
}).strict();
var CoreConversationMessageMetadataSchema = external_exports.object({
  id: id5,
  itemKey: external_exports.string(),
  sequenceNo: counter3,
  recordSequence: counter3,
  byteStart: counter3,
  byteEnd: counter3,
  role: external_exports.enum(["user", "assistant", "system"]),
  source: messageSource,
  timestamp: text4,
  nativeSessionId: text4,
  msgId: text4,
  usageInput: number,
  usageOutput: number,
  usageCacheRead: number,
  usageCacheCreate: number,
  usageCostUsd: external_exports.number().finite().nonnegative().nullable(),
  usageModel: text4,
  turnDurationMs: number,
  turnMessageCount: number,
  compactTrigger: text4,
  compactPreTokens: number,
  compactDurationMs: number,
  rollbackNumTurns: number,
  stopReason: text4,
  synthetic: external_exports.boolean(),
  apiError: external_exports.boolean(),
  errorKind: text4,
  apiErrorStatus: number,
  createdAt: counter3,
  updatedAt: counter3,
  blocksBytes: bytes3,
  factsBytes: bytes3
}).strict();
var CoreConversationReadItemSchema = CoreConversationMessageMetadataSchema.extend({
  blocks: external_exports.unknown().optional(),
  facts: external_exports.unknown().optional(),
  pageContinues: external_exports.literal(true).optional()
}).strict();
var CoreConversationSegmentHeadSchema = external_exports.object({
  id: counter3.refine((value) => value !== "0"),
  sequenceNo: counter3,
  byteStart: counter3,
  byteEnd: counter3,
  role: external_exports.enum(["user", "assistant", "system"]),
  source: messageSource,
  turnId: external_exports.string().nullable(),
  turnDurationMs: counter3.nullable(),
  stopReason: external_exports.string().nullable(),
  hasText: external_exports.boolean(),
  hasImage: external_exports.boolean(),
  textBytes: external_exports.number().int().nonnegative().max(104857600)
}).strict();
var CoreConversationSegmentPageHeadSchema = CoreConversationSegmentHeadSchema.extend({
  segmentText: external_exports.string().max(131072).optional(),
  pageContinues: external_exports.literal(true).optional()
}).strict();

var id6 = external_exports.string().refine((value) => /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n);
var counter4 = external_exports.string().refine((value) => /^(0|[1-9][0-9]{0,18})$/u.test(value) && BigInt(value) <= 9223372036854775807n);
var token = external_exports.string().uuid();
var integer7 = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var CORE_CONVERSATION_READ_FAULT_CODES = Object.freeze([
  "conversation_read_input_invalid",
  "conversation_read_row_invalid",
  "conversation_read_snapshot_unavailable",
  "conversation_read_response_too_large",
  "conversation_read_database_unavailable"
]);
var CORE_CONVERSATION_READ_DIAGNOSTIC_REASONS = Object.freeze([
  "conversation_reply_bytes",
  "punch_page_reply_bytes",
  "punch_page_outer_reply_bytes",
  "punch_fingerprint_rows",
  "punch_item_block_bytes",
  "punch_tool_call_count",
  "punch_prompt_item_block_bytes",
  "punch_latest_assistant_block_bytes",
  "punch_latest_activity_block_bytes",
  "punch_dispatch_rows",
  "punch_child_fact_rows"
]);
var CoreConversationReadDiagnosticSchema = external_exports.object({
  reason: external_exports.enum(CORE_CONVERSATION_READ_DIAGNOSTIC_REASONS),
  observed: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: external_exports.number().int().positive().max(Number.MAX_SAFE_INTEGER)
}).strict();
var CORE_CONVERSATION_READ_TRANSPORT_FAULT_CODES = Object.freeze([
  ...CORE_CONVERSATION_READ_FAULT_CODES,
  "conversation_read_normalized_monitor_capacity",
  "conversation_read_normalized_monitor_unavailable"
]);
var CoreConversationReadTransportFaultCodeSchema = external_exports.enum(CORE_CONVERSATION_READ_TRANSPORT_FAULT_CODES);
var punchSnapshot = external_exports.object({
  scopeFingerprint: external_exports.string().regex(/^[0-9a-f]{64}$/u),
  throughSequence: integer7.nullable(),
  recordWatermark: integer7.nullable(),
  byteWatermark: integer7.nullable()
}).strict();
var punchPageRequest = external_exports.object({
  taskId: id6,
  screenSessionId: id6,
  punchId: id6,
  punchType: external_exports.enum(["main", "subagent"]),
  sourceNativeSessionId: external_exports.string().max(4096).nullable(),
  dispatchIdentity: external_exports.string().max(512).nullable(),
  streamHint: external_exports.string().max(256).nullable().optional(),
  startedAtMs: integer7,
  endedAtMs: integer7.nullable(),
  status: external_exports.enum(["open", "done", "stale", "cancelled"]),
  continuation: external_exports.object({ snapshot: punchSnapshot, afterSequence: integer7 }).strict().nullable(),
  projection: external_exports.enum(["page", "latest-assistant", "timeline", "event-detail"]).optional(),
  detailRange: external_exports.object({ firstSequence: integer7, lastSequence: integer7 }).strict().optional()
}).strict().superRefine((value, context) => {
  if (value.endedAtMs !== null && value.endedAtMs < value.startedAtMs) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "punch page time range is invalid" });
  if (value.projection === "event-detail" !== (value.detailRange !== void 0)) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "event detail range must match projection" });
  if (value.projection === "event-detail" && value.continuation === null) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "event detail requires a scope cursor" });
  if (value.detailRange !== void 0 && value.detailRange.lastSequence < value.detailRange.firstSequence) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "event detail range is invalid" });
});
var anchorCursor = external_exports.object({ streamKey: external_exports.string(), sourceSessionId: counter4 }).strict().nullable();
var factsCursor = external_exports.object({ byteStart: counter4, id: id6 }).strict().nullable();
var selectedCursor = external_exports.object({ value: integer7, id: id6 }).strict().nullable();
var subagentCursor = external_exports.object({ childKey: external_exports.string().min(1).max(4096), ordinal: counter4 }).strict().nullable();
var scope = external_exports.union([
  external_exports.object({ kind: external_exports.literal("session"), id: id6 }).strict(),
  external_exports.object({ kind: external_exports.literal("task"), id: id6, sessionId: id6.optional() }).strict()
]);
var command6 = (operation, input) => external_exports.object({ operation: external_exports.literal(operation), input }).strict();
var CoreConversationReadCommandSchema = external_exports.discriminatedUnion("operation", [
  command6("beginRead", external_exports.object({ scope }).strict()),
  command6("endRead", external_exports.object({ token }).strict()),
  command6("anchorsPage", external_exports.object({ token, after: anchorCursor, limit: integer7.min(1).max(256) }).strict()),
  command6("factsPage", external_exports.object({ token, sourceSessionId: id6, generation: counter4, after: factsCursor, limit: integer7.min(1).max(512) }).strict()),
  command6("sessionSnapshot", external_exports.object({ token, streamKey: external_exports.string() }).strict()),
  command6("countItems", external_exports.object({ token, streamKey: external_exports.string(), generation: counter4 }).strict()),
  command6("readStats", external_exports.object({ token, streamKey: external_exports.string(), generation: counter4, byteStart: counter4.nullable(), byteEnd: counter4.nullable() }).strict()),
  command6("readItems", external_exports.object({ token, streamKey: external_exports.string(), generation: counter4, startSequence: counter4.nullable(), endSequence: counter4.nullable(), afterSequence: counter4.nullable(), query: external_exports.string().max(4096).nullable(), tail: external_exports.boolean(), limit: integer7.max(500) }).strict()),
  command6("streamsPage", external_exports.object({ token, afterStreamKey: external_exports.string().nullable(), limit: integer7.min(1).max(256) }).strict()),
  command6("subagentsPage", external_exports.object({ token, after: subagentCursor, limit: integer7.min(1).max(256) }).strict()),
  command6("subagentsVersion", external_exports.object({ token }).strict()),
  command6("segmentPage", external_exports.object({ token, streamKey: external_exports.string(), generation: counter4, afterSequence: counter4.nullable(), limit: integer7.min(1).max(256) }).strict()),
  command6("fieldChunk", external_exports.object({ token, messageId: id6, field: external_exports.enum(["facts", "blocks", "segmentText"]), offset: integer7.max(104857600), maxBytes: integer7.min(1).max(131072) }).strict()),
  command6("punchPage", external_exports.object({ request: punchPageRequest }).strict()),
  command6("listSelectedSessions", external_exports.object({
    provider: external_exports.string().min(1).max(128).nullable(),
    projectId: id6.nullable(),
    taskId: id6.nullable(),
    order: external_exports.enum(["updated_desc", "created_desc"]),
    after: selectedCursor,
    limit: integer7.min(1).max(100)
  }).strict()),
  command6("selectedSourceContext", external_exports.object({ sessionId: id6 }).strict()),
  command6("writeNormalizedMonitor", external_exports.object({ record: CoreNormalizedMonitorRecordSchema }).strict()),
  command6("readNormalizedMonitor", CoreNormalizedMonitorKeySchema),
  command6("readNormalizedMonitorAvailability", external_exports.object({}).strict()),
  command6("readSelectedConversationAvailability", external_exports.object({ token: token.optional() }).strict())
]);
var CoreConversationReadAnchorSchema = external_exports.object({
  sessionId: id6,
  streamKey: external_exports.string(),
  generation: counter4.nullable(),
  sourceSessionId: id6.nullable(),
  candidates: counter4,
  status: external_exports.enum(["ready", "pending", "partial", "missing", "stale", "error"])
}).strict().superRefine((value, context) => {
  if (value.status === "ready" && (value.generation === null || value.sourceSessionId === null || value.candidates === "0"))
    context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "ready anchor requires a source session" });
});
var CoreConversationReadFactRowSchema = external_exports.object({
  id: id6,
  byteStart: counter4,
  sourceTimestamp: external_exports.string().nullable(),
  factsBytes: integer7.max(104857600),
  provider: external_exports.string(),
  nativeSessionId: external_exports.string().nullable(),
  rootNativeSessionId: external_exports.string().nullable(),
  streamKey: external_exports.string(),
  sessionId: id6
}).strict();
var CoreConversationSubagentRoundSchema = external_exports.object({
  childKey: external_exports.string().min(1).max(4096),
  ordinal: counter4,
  childSessionId: id6.nullable(),
  childProviderSessionId: external_exports.string().min(1).max(4096).nullable(),
  parentSessionId: id6.nullable(),
  streamKey: external_exports.string().max(4096).nullable(),
  dispatchId: external_exports.string().min(1).max(512).nullable(),
  dispatchKind: external_exports.enum(["spawn", "resume"]).nullable(),
  agentName: external_exports.string().max(512).nullable(),
  agentType: external_exports.string().max(512).nullable(),
  byteStart: counter4.nullable(),
  byteEnd: counter4.nullable(),
  startedAt: external_exports.string().nullable(),
  state: external_exports.enum(["ready", "syncing", "pending"]),
  messageCount: counter4,
  firstSequence: counter4.nullable(),
  lastSequence: counter4.nullable(),
  firstTs: external_exports.string().nullable(),
  lastTs: external_exports.string().nullable(),
  newTokens: counter4,
  cacheRead: counter4,
  assignee: external_exports.object({ teamKey: external_exports.string(), agentKey: external_exports.string(), displayName: external_exports.string().nullable() }).strict().nullable()
}).strict();
var CoreConversationReadValueSchemas = {
  writeNormalizedMonitor: external_exports.object({ committed: external_exports.literal(true) }).strict(),
  readNormalizedMonitor: CoreNormalizedMonitorRecordSchema.nullable(),
  readNormalizedMonitorAvailability: external_exports.object({ status: external_exports.literal("ready"), source: external_exports.literal("core-resident"), version: external_exports.literal(1), recordCount: integer7.max(1024) }).strict(),
  readSelectedConversationAvailability: external_exports.object({ status: external_exports.literal("ready"), source: external_exports.literal("postgres"), rowCount: integer7 }).strict(),
  listSelectedSessions: external_exports.object({
    items: external_exports.array(external_exports.object({
      id: id6,
      taskId: id6.nullable(),
      projectId: id6.nullable(),
      title: external_exports.string().max(512).nullable(),
      provider: external_exports.string().min(1).max(128).nullable(),
      providerSessionId: external_exports.string().max(4096).nullable(),
      status: external_exports.enum(["draft", "queued", "starting", "running", "waiting", "completed", "failed", "cancelled", "archived", "unknown"]),
      revision: integer7,
      updatedAt: integer7,
      conversationIndexState: external_exports.enum(["pending", "ready", "partial", "missing", "stale", "error", "unknown"]),
      conversationSourceIdentityKnown: external_exports.boolean()
    }).strict()).max(100),
    next: selectedCursor
  }).strict(),
  selectedSourceContext: external_exports.object({
    screenSessionId: id6,
    taskId: id6.nullable(),
    projectPath: external_exports.string().max(4096).nullable(),
    launchProjectPath: external_exports.string().max(4096).nullable(),
    provider: external_exports.string().min(1).max(128).nullable(),
    providerSessionId: external_exports.string().max(4096).nullable(),
    sourceGeneration: counter4.nullable(),
    revision: integer7,
    createdAt: integer7
  }).strict().nullable(),
  punchPage: external_exports.object({
    state: external_exports.enum(["pending", "indexing", "ready", "partial", "missing", "stale", "error"]),
    screenSessionId: id6,
    sourceGeneration: integer7.nullable(),
    scopeFingerprint: external_exports.string().regex(/^[0-9a-f]{64}$/u).nullable(),
    snapshot: punchSnapshot.nullable(),
    items: external_exports.array(external_exports.object({
      sequenceNo: integer7,
      role: external_exports.enum(["user", "assistant", "system", "tool", "unknown"]),
      itemType: external_exports.enum(["message", "thinking_summary", "tool_summary", "status", "unknown"]),
      displayText: external_exports.string().max(1048576),
      createdAt: integer7.nullable(),
      deferred: external_exports.boolean().optional(),
      tokenUsageKey: external_exports.string().max(520).nullable().optional(),
      toolCalls: external_exports.array(external_exports.object({ key: external_exports.string().min(1).max(560), name: external_exports.string().min(1).max(200) }).strict()).max(256).optional(),
      tokenUsage: external_exports.object({ input: integer7.nullable(), output: integer7.nullable(), cacheRead: integer7.nullable(), cacheWrite: integer7.nullable() }).strict().nullable().optional()
    }).strict()).max(100),
    activity: external_exports.object({
      sequenceNo: integer7,
      role: external_exports.enum(["user", "assistant", "system", "tool", "unknown"]),
      itemType: external_exports.enum(["message", "thinking_summary", "tool_summary", "status", "unknown"]),
      displayText: external_exports.string().max(1048576),
      createdAt: integer7.nullable()
    }).strict().nullable().optional(),
    totalCount: integer7,
    nextSequence: integer7.nullable(),
    errorCode: external_exports.enum([
      "identity_missing",
      "legacy_import_unlinked",
      "identity_pending",
      "stream_missing",
      "round_missing",
      "scope_ambiguous",
      "scope_empty_turn",
      "scope_unsupported",
      "index_pending",
      "source_index_missing",
      "source_index_error",
      "source_index_stale",
      "source_timestamp_missing",
      "cursor_stale",
      "cursor_invalid",
      "transcript_capability_unavailable"
    ]).nullable(),
    retryable: external_exports.boolean()
  }).strict(),
  sessionSnapshot: CoreConversationSessionSnapshotSchema.nullable(),
  countItems: external_exports.object({ count: counter4, lastSequence: counter4.nullable() }).strict(),
  readStats: external_exports.object({ messageCount: counter4, firstTs: external_exports.string().nullable(), lastTs: external_exports.string().nullable() }).strict(),
  readItems: external_exports.array(CoreConversationReadItemSchema).max(500),
  segmentPage: external_exports.array(CoreConversationSegmentPageHeadSchema).max(256),
  streamsPage: external_exports.object({ rows: external_exports.array(external_exports.object({ state: external_exports.enum(["ready", "pending", "partial", "missing", "stale", "error"]), screenSessionId: id6, streamKey: external_exports.string(), toolUseId: external_exports.string().nullable(), agentType: external_exports.string().nullable(), description: external_exports.string().nullable(), assignee: external_exports.object({ teamKey: external_exports.string(), agentKey: external_exports.string(), displayName: external_exports.string().nullable() }).strict().nullable() }).strict()).max(256), next: external_exports.string().nullable() }).strict(),
  subagentsPage: external_exports.object({ rows: external_exports.array(CoreConversationSubagentRoundSchema).max(256), next: subagentCursor }).strict(),
  subagentsVersion: external_exports.object({ familyVersion: external_exports.string().regex(/^[0-9a-f]{32}$/u).nullable() }).strict(),
  beginRead: external_exports.object({ token, diagnostics: external_exports.object({ sourceWithoutMessages: counter4 }).strict() }).strict(),
  endRead: external_exports.object({ closed: external_exports.literal(true) }).strict(),
  anchorsPage: external_exports.object({ rows: external_exports.array(CoreConversationReadAnchorSchema).max(256), next: anchorCursor }).strict(),
  factsPage: external_exports.object({ rows: external_exports.array(CoreConversationReadFactRowSchema).max(512), next: factsCursor }).strict(),
  fieldChunk: external_exports.object({ base64: external_exports.string().max(174764).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u), offset: integer7.max(104857600), totalBytes: integer7.max(104857600) }).strict()
};
var CoreConversationReadFailureSchema = external_exports.object({
  ok: external_exports.literal(false),
  errorCode: CoreConversationReadTransportFaultCodeSchema,
  diagnostic: CoreConversationReadDiagnosticSchema.optional()
}).strict();

var CORE_SCAN_DOWNSTREAM_MAX_INTENTS = 32;
var CORE_SCAN_DOWNSTREAM_MAX_BYTES = 96 * 1024;
var CORE_SCAN_DOWNSTREAM_MAX_PROGRESS_CHUNKS = 128;
var CORE_SCAN_DOWNSTREAM_MAX_PROGRESS_SNAPSHOT_BYTES = 8 * 1024 * 1024;
var decimal = external_exports.string().regex(/^[1-9][0-9]{0,18}$/u).refine((value) => BigInt(value) <= 9223372036854775807n);
var text5 = (max) => external_exports.string().min(1).max(max).refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
var assignee = external_exports.object({ teamKey: text5(256), agentKey: text5(256), displayName: external_exports.string().max(512).nullable() }).strict().nullable();
var CoreScanWorkflowPunchIntentSchema = external_exports.object({
  kind: external_exports.literal("workflow-punch"),
  intentId: external_exports.string().regex(/^[0-9a-f]{64}$/u),
  uid: text5(512),
  taskId: decimal,
  sessionId: decimal,
  name: text5(512),
  start: text5(64),
  end: text5(64).nullable(),
  status: external_exports.enum(["open", "done", "stale", "cancelled"]),
  description: external_exports.string().max(8192),
  sourceNative: text5(512),
  identitySnapshot: external_exports.record(external_exports.unknown()).nullable().optional(),
  usage: external_exports.object({
    input: external_exports.number().finite().nonnegative().optional(),
    output: external_exports.number().finite().nonnegative().optional(),
    cacheRead: external_exports.number().finite().nonnegative().optional(),
    cacheWrite: external_exports.number().finite().nonnegative().optional(),
    reasoning: external_exports.number().finite().nonnegative().optional(),
    costUsd: external_exports.number().finite().nonnegative().nullable().optional()
  }).strict().nullable(),
  assignee,
  model: text5(256).nullable(),
  effort: text5(64).nullable()
}).strict();
var CoreScanMonitorProgressIntentSchema = external_exports.object({
  kind: external_exports.literal("monitor-progress"),
  intentId: external_exports.string().regex(/^[0-9a-f]{64}$/u),
  sessionId: decimal,
  provider: external_exports.enum(["claude", "codex"]),
  nativeSessionId: text5(512),
  ownerEpoch: text5(128),
  snapshotId: external_exports.string().regex(/^[0-9a-f]{64}$/u),
  progressKind: external_exports.enum(["workflows", "subagents"]),
  chunkIndex: external_exports.number().int().nonnegative().max(CORE_SCAN_DOWNSTREAM_MAX_PROGRESS_CHUNKS),
  chunkCount: external_exports.number().int().positive().max(CORE_SCAN_DOWNSTREAM_MAX_PROGRESS_CHUNKS),
  completeMarker: external_exports.boolean(),
  workflows: external_exports.array(ConversationLedgerScanWorkflowRunSummarySchema).max(8).optional(),
  subagents: external_exports.array(ConversationLedgerScanSubagentLiveStatSchema).max(128).optional()
}).strict();
var CoreScanTaskTitleIntentSchema = external_exports.object({
  kind: external_exports.literal("task-title"),
  intentId: external_exports.string().regex(/^[0-9a-f]{64}$/u),
  provider: external_exports.enum(["claude", "codex"]),
  nativeSessionId: text5(512),
  text: text5(512),
  titleKind: external_exports.enum(["ai", "custom"]),
  eventId: text5(512),
  observedAtMs: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
}).strict();
var CoreScanDownstreamIntentSchema = external_exports.discriminatedUnion("kind", [
  CoreScanWorkflowPunchIntentSchema,
  CoreScanMonitorProgressIntentSchema,
  CoreScanTaskTitleIntentSchema
]);
var batchShape = external_exports.object({
  version: external_exports.literal(1),
  batchId: external_exports.string().regex(/^[0-9a-f]{64}$/u),
  sourceSessionId: decimal,
  sourceInstanceId: decimal,
  sourceRevision: decimal,
  generation: decimal,
  provider: external_exports.enum(["claude", "codex"]),
  nativeSessionId: text5(512),
  intents: external_exports.array(CoreScanDownstreamIntentSchema).min(1).max(CORE_SCAN_DOWNSTREAM_MAX_INTENTS)
}).strict();
var CoreScanDownstreamBatchV1Schema = batchShape.superRefine((value, context) => {
  const ids = value.intents.map((intent) => intent.intentId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["intents"], message: "duplicate intent id" });
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > CORE_SCAN_DOWNSTREAM_MAX_BYTES)
    context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["intents"], message: "downstream batch exceeds 96 KiB" });
  const progressGroups = /* @__PURE__ */ new Map();
  const progressChunks = /* @__PURE__ */ new Set();
  for (const intent of value.intents) {
    if (intent.kind === "monitor-progress") {
      const hasMatchingProjection = intent.progressKind === "workflows" ? intent.workflows !== void 0 && intent.subagents === void 0 : intent.subagents !== void 0 && intent.workflows === void 0;
      const markerShape = intent.completeMarker ? intent.chunkIndex === intent.chunkCount && intent.workflows === void 0 && intent.subagents === void 0 : intent.chunkIndex < intent.chunkCount && hasMatchingProjection;
      if (!markerShape) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["intents"], message: "monitor progress chunk shape invalid" });
      const key4 = `${intent.ownerEpoch}\0${intent.snapshotId}`;
      const chunkKey = `${key4}\0${intent.chunkIndex}`;
      if (progressChunks.has(chunkKey)) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["intents"], message: "duplicate monitor progress chunk" });
      progressChunks.add(chunkKey);
      const previous = progressGroups.get(key4);
      if (previous !== void 0 && (previous.progressKind !== intent.progressKind || previous.chunkCount !== intent.chunkCount || previous.sessionId !== intent.sessionId || previous.nativeSessionId !== intent.nativeSessionId || previous.provider !== intent.provider))
        context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["intents"], message: "monitor progress snapshot identity conflict" });
      else progressGroups.set(key4, intent);
    }
    if ("provider" in intent && intent.provider !== value.provider || "nativeSessionId" in intent && intent.nativeSessionId !== value.nativeSessionId)
      context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["intents"], message: "intent source mismatch" });
  }
});
var CoreScanDownstreamReceiptSchema = external_exports.object({
  batchId: external_exports.string().regex(/^[0-9a-f]{64}$/u),
  intentId: external_exports.string().regex(/^[0-9a-f]{64}$/u),
  status: external_exports.enum(["applied", "already-applied", "protected", "stale"]),
  inputDigest: external_exports.string().regex(/^[0-9a-f]{64}$/u).optional(),
  resultPunchId: decimal.optional(),
  ownerEpoch: text5(128).optional()
}).strict();

var decimalId = external_exports.string().regex(/^[1-9][0-9]{0,18}$/u).refine((value) => BigInt(value) <= 9223372036854775807n);
var sourceTarget = external_exports.object({
  sessionId: decimalId,
  provider: external_exports.enum(["claude", "codex"]),
  providerSessionId: external_exports.string().min(1).max(512),
  sourceRef: external_exports.string().min(1).max(4096).refine((value) => value.trim() === value)
}).strict();
var sourceTargets = external_exports.array(sourceTarget).max(2e4).superRefine((targets, context) => {
  if (new Set(targets.map((target) => target.sessionId)).size !== targets.length) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "scanner source targets must be unique", path: [] });
});
var CoreConversationScannerSourceGroupSchema = external_exports.object({
  rootSessionId: decimalId,
  sessionIds: external_exports.array(decimalId).min(1).max(2e4).superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "group session ids must be unique", path: [] });
  }),
  targets: sourceTargets
}).strict();
var snapshotRevision = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var activeGroups = external_exports.array(CoreConversationScannerSourceGroupSchema).max(500);
var focusedSessionId = decimalId.nullable();
var focusedSessionIds = external_exports.array(decimalId).max(2e4).nullable().superRefine((ids, context) => {
  if (ids !== null && new Set(ids).size !== ids.length) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "focused session ids must be unique", path: [] });
});
var focusedTargets = sourceTargets.nullable();
var MAX_SCAN_TARGETS = 2e4;
var ConversationScannerScopeChangedSessionsSchema = external_exports.array(decimalId).max(MAX_SCAN_TARGETS).superRefine((sessionIds, context) => {
  if (new Set(sessionIds).size !== sessionIds.length) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "scope-changed session ids must be unique", path: [] });
});
var ConversationScannerContentSavedReceiptSchema = external_exports.object({
  sessionId: decimalId,
  provider: external_exports.enum(["claude", "codex"]),
  providerSessionId: external_exports.string().min(1).max(512),
  providerTurnId: external_exports.string().min(1).max(512),
  sourceGeneration: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sequenceNo: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  itemKey: external_exports.string().min(1).max(4096).optional(),
  byteStart: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  sourceFileIdentity: external_exports.string().min(1).max(128).optional(),
  sourceAttemptId: external_exports.string().regex(/^[a-f0-9]{64}$/).optional(),
  role: external_exports.string().min(1).max(64).optional()
}).strict();
var ConversationScannerContentSavedReceiptsSchema = external_exports.array(ConversationScannerContentSavedReceiptSchema).max(200).superRefine((receipts, context) => {
  const keys = receipts.map((receipt) => `${receipt.sessionId}\0${receipt.providerSessionId}\0${receipt.providerTurnId}\0${receipt.sourceGeneration}\0${receipt.sequenceNo}`);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "content-saved receipts must be unique", path: [] });
});
var CoreConversationScannerSourceSnapshotSchema = external_exports.object({
  revision: snapshotRevision,
  activeGroups,
  focusedSessionId,
  focusedSessionIds,
  focusedTargets
}).strict().superRefine((snapshot2, context) => {
  if (new Set(snapshot2.activeGroups.map((group) => group.rootSessionId)).size !== snapshot2.activeGroups.length) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "active scan roots must be unique", path: ["activeGroups"] });
  const activeSessionIds = snapshot2.activeGroups.flatMap((group) => group.sessionIds);
  if (new Set(activeSessionIds).size !== activeSessionIds.length) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "active scan session ids must be globally unique", path: ["activeGroups"] });
  if (activeSessionIds.length + (snapshot2.focusedSessionIds?.length ?? 0) > MAX_SCAN_TARGETS) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "scanner session snapshot exceeds its aggregate limit", path: ["activeGroups"] });
  for (const [groupIndex, group] of snapshot2.activeGroups.entries()) {
    if (!group.sessionIds.includes(group.rootSessionId)) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "group session ids must include the root", path: ["activeGroups", groupIndex, "sessionIds"] });
    const ids = new Set(group.sessionIds);
    for (const target of group.targets) if (!ids.has(target.sessionId)) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "group source targets must belong to its session ids", path: ["activeGroups", groupIndex, "targets"] });
  }
  const activeIds = snapshot2.activeGroups.flatMap((group) => group.targets.map((target) => target.sessionId));
  if (new Set(activeIds).size !== activeIds.length) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "active scan targets must be globally unique", path: ["activeGroups"] });
  if (activeIds.length + (snapshot2.focusedTargets?.length ?? 0) > MAX_SCAN_TARGETS) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "scanner target snapshot exceeds its aggregate limit", path: ["activeGroups"] });
  if (snapshot2.focusedSessionId === null !== (snapshot2.focusedTargets === null) || snapshot2.focusedSessionId === null !== (snapshot2.focusedSessionIds === null)) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "focused session, session ids, and targets must be present together", path: ["focusedTargets"] });
  if (snapshot2.focusedSessionId !== null && snapshot2.focusedSessionIds !== null) {
    if (!snapshot2.focusedSessionIds.includes(snapshot2.focusedSessionId)) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "focused session ids must include the selected session", path: ["focusedSessionIds"] });
    const ids = new Set(snapshot2.focusedSessionIds);
    for (const target of snapshot2.focusedTargets ?? []) if (!ids.has(target.sessionId)) context.addIssue({ code: external_exports.ZodIssueCode.custom, message: "focused source targets must belong to the focused session ids", path: ["focusedTargets"] });
  }
});
var ConversationScannerMemorySchema = external_exports.object({
  rss: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  peakRss: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  privateBytes: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  heapBytes: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  heapPeakBytes: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
}).strict();
var ConversationScannerMembershipCommandSchema = external_exports.object({
  kind: external_exports.literal("membership"),
  revision: snapshotRevision,
  activeGroups,
  focusedSessionId,
  focusedSessionIds,
  focusedTargets
}).strict().superRefine((membership, context) => {
  const parsed = CoreConversationScannerSourceSnapshotSchema.safeParse({
    revision: membership.revision,
    activeGroups: membership.activeGroups,
    focusedSessionId: membership.focusedSessionId,
    focusedSessionIds: membership.focusedSessionIds,
    focusedTargets: membership.focusedTargets
  });
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue(issue);
});
var ConversationScannerMembershipAppliedSchema = external_exports.object({
  kind: external_exports.literal("membershipApplied"),
  revision: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  changed: external_exports.boolean(),
  activeGroups: external_exports.number().int().nonnegative().max(500),
  focused: external_exports.boolean(),
  scannerPid: external_exports.number().int().positive().max(4294967295),
  memory: ConversationScannerMemorySchema.nullable()
}).strict();

var code = external_exports.string().regex(/^[a-z0-9_-]{1,96}$/u);
var integer8 = external_exports.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
var RustErrorDiagnosticSchema = external_exports.object({
  version: external_exports.literal(1),
  module: external_exports.enum(["rust-core", "rust-scanner"]),
  pid: integer8.min(1),
  stage: code,
  code,
  cause: code,
  sources: external_exports.array(external_exports.enum(["io", "postgres", "postgres_wrong_type", "json", "other"])).max(8),
  sqlstate: external_exports.string().regex(/^[A-Z0-9]{5}$/u).optional(),
  ioKind: external_exports.string().regex(/^[a-z]{1,32}$/u).optional(),
  osCode: external_exports.number().int().min(-2147483648).max(2147483647).optional(),
  parameter: integer8.optional(),
  jsonCategory: external_exports.enum(["io", "syntax", "data", "eof"]).optional(),
  line: integer8.optional(),
  column: integer8.optional(),
  tool: external_exports.enum(["initdb", "postgres_version", "pg_ctl_start", "pg_ctl_stop", "pg_ctl_status"]).optional(),
  exitCode: external_exports.number().int().min(-2147483648).max(2147483647).optional(),
  actualCount: integer8.optional(),
  expectedCount: integer8.optional(),
  sessionId: external_exports.string().refine((value) => /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n).optional(),
  heartbeatAgeMs: integer8.optional(),
  inboundAgeMs: integer8.optional(),
  runtimeLagMs: integer8.optional(),
  busyCount: integer8.optional(),
  pumpPhase: external_exports.enum(["reading", "forwarding", "host-response"]).optional(),
  pgPid: integer8.min(1).optional(),
  durationMs: integer8.optional(),
  requestKind: code.optional(),
  requestAgeMs: integer8.optional()
}).strict();

var PUBLIC_PAGE_EXPOSED_CONTENT = "AI 花費總覽";
var SHARING_CONFIRM_BODY = `開啟後，任何拿到網址的人不需要密碼就能看到你的個人網頁（${PUBLIC_PAGE_EXPOSED_CONTENT}）。`;

var CoreBackendConnectionInfoSchema = external_exports.object({
  mode: external_exports.literal("embedded"),
  host: external_exports.string().min(1).max(255),
  port: external_exports.number().int().min(1).max(65535),
  database: external_exports.string().min(1).max(128),
  user: external_exports.string().min(1).max(128),
  password: external_exports.string().min(1).max(256)
}).strict();

var CONVERSATION_SCANNER_OVERVIEW_ERROR_CODES = [
  "scanner_overview_database_unavailable",
  "scanner_overview_query_failed",
  "scanner_overview_query_timeout",
  "scanner_overview_result_invalid"
];
var SafeNonNegativeIntegerSchema = external_exports.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var SafeCodeSchema = external_exports.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u);
var CountSchema = external_exports.string().regex(/^(0|[1-9][0-9]*)$/u).nullable();
var ProviderSchema = external_exports.enum(["claude", "codex"]);
var ConversationScannerOverviewGetSnapshotRequestSchema = external_exports.object({
  refreshDatabase: external_exports.boolean()
}).strict();
var ConversationScannerOverviewActivityV1Schema = external_exports.object({
  runningTickCount: SafeNonNegativeIntegerSchema,
  oldestTickStartedAtMs: SafeNonNegativeIntegerSchema.nullable(),
  lastReply: external_exports.object({
    observedAtMs: SafeNonNegativeIntegerSchema,
    kind: external_exports.enum(["idle", "scanned"]),
    errorCount: SafeNonNegativeIntegerSchema
  }).strict().nullable(),
  latestError: external_exports.object({
    observedAtMs: SafeNonNegativeIntegerSchema,
    source: external_exports.enum(["tickReply", "tickCommand"]),
    errorCount: SafeNonNegativeIntegerSchema,
    samples: external_exports.array(external_exports.object({ stage: SafeCodeSchema, code: SafeCodeSchema }).strict()).max(3).readonly()
  }).strict().nullable()
}).strict();
var ConversationScannerOverviewRuntimeV1Schema = external_exports.object({
  lifecycle: external_exports.enum(["idle", "configuring", "configured", "active", "recovering", "degraded", "failed", "closing", "closed"]),
  readiness: external_exports.object({
    state: external_exports.enum(["ready", "blocked"]),
    reason: SafeCodeSchema.nullable(),
    missingCapabilities: external_exports.array(SafeCodeSchema).max(32)
  }).strict().nullable(),
  activity: ConversationScannerOverviewActivityV1Schema
}).strict();
var ConversationScannerOverviewProviderV1Schema = external_exports.object({
  provider: ProviderSchema,
  sourceSessionCount: CountSchema,
  nonSyntheticMessageCount: CountSchema,
  newestInsertedMessageAtMs: SafeNonNegativeIntegerSchema.nullable()
}).strict();
var ConversationScannerOverviewDatabaseV1Schema = external_exports.object({
  status: external_exports.enum(["fresh", "cached", "stale", "unavailable"]),
  sampledAtMs: SafeNonNegativeIntegerSchema.nullable(),
  errorCode: external_exports.enum(CONVERSATION_SCANNER_OVERVIEW_ERROR_CODES).nullable(),
  providers: external_exports.tuple([
    ConversationScannerOverviewProviderV1Schema,
    ConversationScannerOverviewProviderV1Schema
  ]).readonly().superRefine(([claude, codex], context) => {
    if (claude.provider !== "claude") context.addIssue({ code: external_exports.ZodIssueCode.custom, path: [0, "provider"], message: "claude provider row required first" });
    if (codex.provider !== "codex") context.addIssue({ code: external_exports.ZodIssueCode.custom, path: [1, "provider"], message: "codex provider row required second" });
  })
}).strict().superRefine((database, context) => {
  const counts = database.providers.flatMap((provider3) => [provider3.sourceSessionCount, provider3.nonSyntheticMessageCount]);
  if (database.status === "unavailable") {
    if (database.sampledAtMs !== null) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["sampledAtMs"], message: "unavailable database cannot have a successful sample time" });
    if (counts.some((count2) => count2 !== null)) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["providers"], message: "unavailable database counts must be unknown" });
    if (database.errorCode === null) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["errorCode"], message: "unavailable database requires a safe error code" });
  } else {
    if (database.sampledAtMs === null) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["sampledAtMs"], message: "sampled database requires a sample time" });
    if (counts.some((count2) => count2 === null)) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["providers"], message: "sampled database requires exact provider counts" });
    if (database.status === "stale" && database.errorCode === null) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["errorCode"], message: "stale database requires a safe error code" });
  }
});
var DecimalIdSchema = external_exports.string().regex(/^[1-9][0-9]{0,18}$/u);
var DisplayTextRegex = /^[^\u0000-\u001f\u007f]+$/u;
var TitleSchema = external_exports.string().min(1).max(120).regex(DisplayTextRegex).nullable();
var ProjectPathSchema = external_exports.string().min(1).max(400).regex(DisplayTextRegex).nullable();
var NativeIdTailSchema = external_exports.string().regex(/^[A-Za-z0-9_.:-]{1,8}$/u).nullable();
var CONVERSATION_SCANNER_LANE_SESSIONS_ROSTER_LIMIT = 50;
var CONVERSATION_SCANNER_LANE_SESSIONS_SUBSESSION_LIMIT = 50;
var CONVERSATION_SCANNER_LANE_SESSIONS_HISTORY_QUEUE_LIMIT = 20;
var ConversationScannerOverviewLaneSubsessionV1Schema = external_exports.object({
  sessionId: DecimalIdSchema,
  parentSessionId: DecimalIdSchema,
  depth: external_exports.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  provider: ProviderSchema.nullable(),
  monitorStatus: external_exports.enum(["realtime", "new", "active"]),
  title: TitleSchema,
  projectPath: ProjectPathSchema,
  nativeIdTail: NativeIdTailSchema
}).strict();
var ConversationScannerOverviewLaneSessionEntryV1Schema = external_exports.object({
  sessionId: DecimalIdSchema,
  provider: ProviderSchema.nullable(),
  monitorStatus: external_exports.enum(["realtime", "new", "active"]),
  title: TitleSchema,
  projectPath: ProjectPathSchema,
  nativeIdTail: NativeIdTailSchema,
  subsessionTotal: SafeNonNegativeIntegerSchema,
  subsessions: external_exports.array(ConversationScannerOverviewLaneSubsessionV1Schema).max(CONVERSATION_SCANNER_LANE_SESSIONS_SUBSESSION_LIMIT).readonly()
}).strict();
var ConversationScannerOverviewLaneRosterV1Schema = external_exports.object({
  total: SafeNonNegativeIntegerSchema,
  rootTotal: SafeNonNegativeIntegerSchema,
  sessions: external_exports.array(ConversationScannerOverviewLaneSessionEntryV1Schema).max(CONVERSATION_SCANNER_LANE_SESSIONS_ROSTER_LIMIT).readonly()
}).strict().superRefine((roster, context) => {
  if (roster.rootTotal > roster.total) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["rootTotal"], message: "rootTotal cannot exceed total" });
  if (roster.sessions.length > roster.rootTotal) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["sessions"], message: "listed sessions cannot exceed rootTotal" });
  roster.sessions.forEach((session, sessionIndex) => {
    if (session.subsessions.length > session.subsessionTotal) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["sessions", sessionIndex, "subsessions"], message: "listed subsessions cannot exceed subsessionTotal" });
    const ids = /* @__PURE__ */ new Set([session.sessionId]);
    for (const [subsessionIndex, subsession] of session.subsessions.entries()) {
      if (ids.has(subsession.sessionId)) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["sessions", sessionIndex, "subsessions", subsessionIndex, "sessionId"], message: "a subsession cannot duplicate another family member" });
      ids.add(subsession.sessionId);
    }
    for (const [subsessionIndex, subsession] of session.subsessions.entries()) {
      if (!ids.has(subsession.parentSessionId)) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["sessions", sessionIndex, "subsessions", subsessionIndex, "parentSessionId"], message: "a listed subsession must identify its visible parent" });
      if (subsession.parentSessionId === subsession.sessionId) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["sessions", sessionIndex, "subsessions", subsessionIndex, "parentSessionId"], message: "a subsession cannot be its own parent" });
    }
  });
});
var ConversationScannerOverviewHistoryQueueEntryV1Schema = external_exports.object({
  position: external_exports.number().int().min(1).max(CONVERSATION_SCANNER_LANE_SESSIONS_HISTORY_QUEUE_LIMIT),
  provider: ProviderSchema,
  isChild: external_exports.boolean(),
  familyMtimeMs: SafeNonNegativeIntegerSchema.nullable(),
  sessionId: DecimalIdSchema.nullable(),
  title: TitleSchema,
  projectPath: ProjectPathSchema,
  nativeIdTail: NativeIdTailSchema
}).strict();
var ConversationScannerOverviewHistoryLaneV1Schema = external_exports.object({
  responsibleSourceCount: SafeNonNegativeIntegerSchema.nullable(),
  responsibleSampledAtMs: SafeNonNegativeIntegerSchema.nullable(),
  queue: external_exports.object({
    observedAtMs: SafeNonNegativeIntegerSchema,
    queuedSourceCount: SafeNonNegativeIntegerSchema,
    eligibleSourceCount: SafeNonNegativeIntegerSchema,
    entries: external_exports.array(ConversationScannerOverviewHistoryQueueEntryV1Schema).max(CONVERSATION_SCANNER_LANE_SESSIONS_HISTORY_QUEUE_LIMIT).readonly()
  }).strict().nullable()
}).strict().superRefine((history, context) => {
  history.queue?.entries.forEach((entry2, index) => {
    if (entry2.position !== index + 1) context.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["queue", "entries", index, "position"], message: "positions must be consecutive from 1" });
  });
});
var ConversationScannerOverviewLaneSessionsV1Schema = external_exports.object({
  status: external_exports.enum(["fresh", "cached", "stale", "unavailable"]),
  sampledAtMs: SafeNonNegativeIntegerSchema.nullable(),
  errorCode: external_exports.enum(CONVERSATION_SCANNER_OVERVIEW_ERROR_CODES).nullable(),
  realtime: ConversationScannerOverviewLaneRosterV1Schema.nullable(),
  active: ConversationScannerOverviewLaneRosterV1Schema.nullable(),
  history: ConversationScannerOverviewHistoryLaneV1Schema.nullable()
}).strict().superRefine((lanes, context) => {
  const issue = (path, message) => context.addIssue({ code: external_exports.ZodIssueCode.custom, path: [path], message });
  if (lanes.status === "unavailable") {
    if (lanes.sampledAtMs !== null) issue("sampledAtMs", "unavailable lane sessions cannot have a successful sample time");
    if (lanes.realtime !== null || lanes.active !== null || lanes.history !== null) issue("realtime", "unavailable lane sessions cannot carry rosters");
    if (lanes.errorCode === null) issue("errorCode", "unavailable lane sessions require a safe error code");
    return;
  }
  if (lanes.sampledAtMs === null) issue("sampledAtMs", "sampled lane sessions require a sample time");
  if (lanes.realtime === null || lanes.active === null || lanes.history === null) issue("realtime", "sampled lane sessions require every lane");
  if (lanes.status === "stale" && lanes.errorCode === null) issue("errorCode", "stale lane sessions require a safe error code");
  if (lanes.realtime?.sessions.some((entry2) => entry2.monitorStatus === "active")) issue("realtime", "the realtime lane cannot list active sessions");
  if (lanes.active?.sessions.some((entry2) => entry2.monitorStatus !== "active")) issue("active", "the active lane can only list active sessions");
});
var ConversationScannerOverviewSnapshotV1Schema = external_exports.object({
  schemaVersion: external_exports.literal(1),
  sampledAtMs: SafeNonNegativeIntegerSchema,
  runtime: ConversationScannerOverviewRuntimeV1Schema.nullable(),
  database: ConversationScannerOverviewDatabaseV1Schema,
  laneSessions: ConversationScannerOverviewLaneSessionsV1Schema
}).strict();

function isCorrelatedProgramReplyV1(reply, requestId5, operation) {
  return reply.requestId === requestId5 && reply.operation === operation;
}
function createProgramApi(ipc) {
  return Object.freeze({
    call: async (operation, input, options) => {
      const requestId5 = options?.requestId ?? globalThis.crypto.randomUUID();
      const reply = await ipc.invoke(PLUGIN_PROGRAM_API_CHANNELS_V1.REQUEST, { apiVersion: 1, requestId: requestId5, operation, input });
      const parsed = ProgramReplyV1Schema.safeParse(reply);
      if (parsed.success && isCorrelatedProgramReplyV1(parsed.data, requestId5, operation)) return parsed.data;
      return { apiVersion: 1, requestId: requestId5, operation, ok: false, error: { code: "unavailable", message: "The Program API is unavailable." } };
    }
  });
}

var DoneSchema = external_exports.object({ done: external_exports.literal(true) }).strict();
function createStoreApi(ipc, call) {
  const read2 = (request) => call(PLUGIN_CORE_CHANNELS.STORE, request);
  const act = (request) => call(PLUGIN_CORE_CHANNELS.STORE_ACQUIRE, request);
  const listeners = /* @__PURE__ */ new Set();
  let attached = false;
  let subscribing = false;
  let generation3 = 0;
  const subscription = (op) => PluginStoreAuthorSubscriptionRequestV1Schema.parse({ protocolVersion: 1, op });
  const wrapped = (_event, raw) => {
    const parsed = PluginStoreAuthorEventV1Schema.safeParse(raw);
    if (parsed.success) for (const listener of listeners) listener(parsed.data);
  };
  const detach = () => {
    generation3 += 1;
    if (attached) ipc.removeListener(PLUGIN_CORE_CHANNELS.STORE_EVENT, wrapped);
    attached = false;
    void ipc.invoke(PLUGIN_CORE_CHANNELS.STORE_EVENT, subscription("unsubscribe")).catch(() => void 0);
  };
  const attach = () => {
    if (attached) return;
    attached = true;
    const current = ++generation3;
    ipc.on(PLUGIN_CORE_CHANNELS.STORE_EVENT, wrapped);
    if (subscribing) return;
    subscribing = true;
    void ipc.invoke(PLUGIN_CORE_CHANNELS.STORE_EVENT, subscription("subscribe")).then((raw) => {
      const response = PluginStoreAuthorSubscriptionResultV1Schema.parse(raw);
      if (!response.subscribed) {
        if (attached) detach();
        return;
      }
      if (listeners.size === 0) {
        if (current === generation3) detach();
        else void ipc.invoke(PLUGIN_CORE_CHANNELS.STORE_EVENT, subscription("unsubscribe")).catch(() => void 0);
      }
    }).catch(() => {
      if (listeners.size === 0 && attached) detach();
    }).finally(() => {
      subscribing = false;
    });
  };
  const api = {
    status: async (options) => PluginStoreStatusViewV1Schema.parse(await read2({ op: "status", ...options?.refresh === true ? { refresh: true } : {} })),
    list: async (query) => PluginStoreListViewV1Schema.parse(await read2({
      op: "list",
      ...query?.text === void 0 ? {} : { text: String(query.text) },
      ...query?.tags === void 0 ? {} : { tags: Array.from(query.tags, String) },
      ...query?.cursor === void 0 ? {} : { cursor: query.cursor === null ? null : String(query.cursor) },
      ...query?.limit === void 0 ? {} : { limit: Number(query.limit) }
    })),
    get: async (entryId2) => external_exports.union([PluginStoreEntryDetailViewV1Schema, external_exports.null()]).parse(await read2({ op: "get", entryId: String(entryId2) })),
    preflight: async (entryId2) => PluginStorePreflightViewV1Schema.parse(await read2({ op: "preflight", entryId: String(entryId2) })),
    acquire: async (entryId2) => PluginStoreAcquireOutcomeV1Schema.parse(await act({ op: "acquire", entryId: String(entryId2) })),
    cancel: async (entryId2, options) => {
      DoneSchema.parse(await act({ op: "cancel", entryId: String(entryId2), ...options?.discard === true ? { discard: true } : {} }));
    },
    rollback: async (entryId2) => PluginStoreRollbackOutcomeV1Schema.parse(await act({ op: "rollback", entryId: String(entryId2) })),
    library: async () => PluginStoreAuthorLibraryV1Schema.parse(await read2(PluginStoreAuthorLibraryRequestV1Schema.parse({ protocolVersion: 1, op: "library" }))),
    onEvent: (listener) => {
      if (typeof listener !== "function") throw new TypeError("store.onEvent requires a function");
      listeners.add(listener);
      attach();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) detach();
      };
    }
  };
  return Object.freeze(api);
}

function toBytes2(data) {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError("data must be a Uint8Array, an ArrayBuffer or a string");
}
var urlPath = (relative) => String(relative).split("/").map(encodeURIComponent).join("/");
function createPluginViewApi(ipc, origin2 = () => globalThis.location.origin) {
  const call = async (channel, request) => {
    const envelope3 = PluginCoreEnvelopeSchema.parse(await ipc.invoke(channel, request));
    if (!envelope3.ok) throw new Error(envelope3.error);
    return envelope3.value;
  };
  const manage = (request) => call(PLUGIN_CORE_CHANNELS.ASSET_PACK_MANAGE, request);
  const modelCall = async (request) => {
    const envelope3 = PluginModelsEnvelopeV1Schema.parse(await ipc.invoke(PLUGIN_MODELS_CHANNELS.ACT, request));
    if (!envelope3.ok) throw Object.assign(new Error(envelope3.error), { code: envelope3.error });
    return envelope3.value;
  };
  const storage = Object.freeze({
    read: async (path, range) => await call(PLUGIN_CORE_CHANNELS.STORAGE, { op: "read", path: String(path), ...range?.offset === void 0 ? {} : { offset: range.offset }, ...range?.length === void 0 ? {} : { length: range.length } }),
    readText: async (path) => new TextDecoder().decode(await call(PLUGIN_CORE_CHANNELS.STORAGE, { op: "read", path: String(path) })),
    write: async (path, data, options) => call(PLUGIN_CORE_CHANNELS.STORAGE, { op: "write", path: String(path), data: toBytes2(data), ...options?.append === void 0 ? {} : { append: options.append } }),
    list: (path) => call(PLUGIN_CORE_CHANNELS.STORAGE, { op: "list", ...path === void 0 ? {} : { path: String(path) } }),
    stat: (path) => call(PLUGIN_CORE_CHANNELS.STORAGE, { op: "stat", path: String(path) }),
    remove: (path, options) => call(PLUGIN_CORE_CHANNELS.STORAGE, { op: "remove", path: String(path), ...options?.recursive === void 0 ? {} : { recursive: options.recursive } })
  });
  const settings = Object.freeze({
    get: (key4) => call(PLUGIN_CORE_CHANNELS.SETTINGS, { op: "get", key: String(key4) }),
    set: (key4, value) => call(PLUGIN_CORE_CHANNELS.SETTINGS, { op: "set", key: String(key4), value }),
    remove: (key4) => call(PLUGIN_CORE_CHANNELS.SETTINGS, { op: "remove", key: String(key4) }),
    all: () => call(PLUGIN_CORE_CHANNELS.SETTINGS, { op: "all" })
  });
  const secrets = Object.freeze({
    get: (name) => call(PLUGIN_CORE_CHANNELS.SECRETS, { op: "get", name: String(name) }),
    set: (name, value) => call(PLUGIN_CORE_CHANNELS.SECRETS, { op: "set", name: String(name), value: String(value) }),
    remove: (name) => call(PLUGIN_CORE_CHANNELS.SECRETS, { op: "remove", name: String(name) }),
    list: () => call(PLUGIN_CORE_CHANNELS.SECRETS, { op: "list" }),
    available: () => call(PLUGIN_CORE_CHANNELS.SECRETS, { op: "available" })
  });
  const assetPacks = Object.freeze({
    list: () => call(PLUGIN_CORE_CHANNELS.ASSET_PACKS, { op: "list" }),
    files: (packId2) => call(PLUGIN_CORE_CHANNELS.ASSET_PACKS, { op: "files", packId: String(packId2) }),
    url: (packId2, path) => `${origin2()}/asset-pack/${encodeURIComponent(String(packId2))}/${urlPath(path)}`,
    import: async () => PluginAssetPackImportResultSchema.parse(await manage({ op: "import" })),
    remove: async (packId2) => PluginAssetPackRemoveResultSchema.parse(await manage({ op: "remove", packId: String(packId2) })),
    acquire: async (packId2) => {
      const response = await modelCall({ op: "acquire", packId: String(packId2) });
      return ModelAcquireOutcomeV1Schema.parse(response);
    },
    cancel: async (packId2) => {
      PluginModelsCancelResultV1Schema.parse({ protocolVersion: 1, ok: true, value: await modelCall({ op: "cancel", packId: String(packId2) }) });
    },
    onProgress: (() => {
      const listeners = /* @__PURE__ */ new Set();
      let listening = false;
      let subscribing = false;
      const wrapped = (_event, payload) => {
        const parsed = PluginModelsProgressEventV1Schema.safeParse(payload);
        if (parsed.success) for (const listener of listeners) listener(parsed.data.progress);
      };
      const request = PluginModelsProgressSubscriptionRequestV1Schema.parse({ protocolVersion: 1 });
      const unsubscribeMain = () => {
        void ipc.invoke(PLUGIN_MODELS_CHANNELS.PROGRESS_UNSUBSCRIBE, request).then((raw) => PluginModelsProgressSubscriptionResultV1Schema.parse(raw)).catch(() => void 0);
      };
      const subscribeMain = () => {
        if (subscribing) return;
        subscribing = true;
        void ipc.invoke(PLUGIN_MODELS_CHANNELS.PROGRESS_SUBSCRIBE, request).then((raw) => {
          const response = PluginModelsProgressSubscriptionResultV1Schema.parse(raw);
          if (response.subscribed && listeners.size === 0) unsubscribeMain();
        }).catch(() => {
          if (listeners.size === 0) unsubscribeMain();
        }).finally(() => {
          subscribing = false;
        });
      };
      return (listener) => {
        if (typeof listener !== "function") throw new TypeError("assetPacks.onProgress requires a function");
        listeners.add(listener);
        if (!listening) {
          listening = true;
          ipc.on(PLUGIN_MODELS_CHANNELS.PROGRESS, wrapped);
          subscribeMain();
        }
        return () => {
          listeners.delete(listener);
          if (listeners.size !== 0 || !listening) return;
          listening = false;
          ipc.removeListener(PLUGIN_MODELS_CHANNELS.PROGRESS, wrapped);
          if (!subscribing) unsubscribeMain();
        };
      };
    })()
  });
  const store = createStoreApi(ipc, call);
  const assets = Object.freeze({ url: (path) => `${origin2()}/data/${urlPath(path)}` });
  const backend = Object.freeze({
    call: async (method2, params) => {
      const request = PluginBackendInvokeRequestV1Schema.parse({ method: method2, params });
      const result = PluginBackendInvokeResultV1Schema.parse(await ipc.invoke(PLUGIN_BACKEND_INVOKE_CHANNEL, request));
      if (!result.ok) throw new Error(result.error);
      return result.value;
    }
  });
  const presentation = Object.freeze({
    get: async () => PluginViewPresentationStateSchema.parse(await ipc.invoke(PLUGIN_VIEW_CHANNELS.PRESENTATION_GET)),
    request: async (mode, options) => {
      const fullscreen = options?.fullscreen;
      return PluginViewPresentationResultSchema.parse(await ipc.invoke(PLUGIN_VIEW_CHANNELS.PRESENTATION_REQUEST, {
        mode: String(mode),
        ...typeof fullscreen === "boolean" ? { fullscreen } : {}
      }));
    },
    onChange: (listener) => {
      if (typeof listener !== "function") throw new TypeError("presentation.onChange requires a function");
      const wrapped = (_event, payload) => {
        const parsed = PluginViewPresentationChangeSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipc.on(PLUGIN_VIEW_CHANNELS.PRESENTATION_CHANGED, wrapped);
      return () => ipc.removeListener(PLUGIN_VIEW_CHANNELS.PRESENTATION_CHANGED, wrapped);
    }
  });
  const capabilityApi = createCapabilityApi(ipc);
  const capability = Object.freeze({ list: capabilityApi.list, openLink: capabilityApi.openLink, onChange: capabilityApi.onChange });
  const ai = Object.freeze({
    ...createAiChatApi(ipc),
    complete: async (request) => AiChatCompleteResultSchema.parse(await call(PLUGIN_AI_CHANNELS.REQUEST, { ...request, op: "complete" }))
  });
  const input = createInputApi(ipc);
  const program = createProgramApi(ipc);
  const agentAvatar = Object.freeze({
    read: async (agentId) => {
      const envelope3 = PluginCoreEnvelopeSchema.parse(await ipc.invoke(PLUGIN_CORE_CHANNELS.AGENT_AVATAR, { protocolVersion: 1, agentId: String(agentId) }));
      if (!envelope3.ok) throw new Error(envelope3.error);
      const result = PluginAgentAvatarResultV1Schema.parse(envelope3.value);
      return result.image === null ? null : { ...result.image, bytes: new Uint8Array(result.image.bytes) };
    }
  });
  return Object.freeze({ presentation, storage, settings, secrets, assetPacks, store, assets, capability, ai, input, backend, agentAvatar, program });
}

function createExternalSettings(initial, enabled = initial !== void 0) {
  let values = Object.freeze({ ...initial ?? {} });
  let allowed = enabled;
  const listeners = /* @__PURE__ */ new Set();
  const assertAllowed = () => {
    if (!allowed) throw new Error("plugin_permission_denied");
  };
  const api = Object.freeze({
    all: () => {
      assertAllowed();
      return values;
    },
    get: (key4) => {
      assertAllowed();
      return values[key4];
    },
    onChange: (listener) => {
      assertAllowed();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  });
  return {
    api,
    apply: (raw) => {
      const parsed = ExternalSettingsMessageSchema.safeParse(raw);
      if (!parsed.success) return;
      if (!parsed.data.enabled) {
        allowed = false;
        values = Object.freeze({});
        listeners.clear();
        return;
      }
      allowed = true;
      values = Object.freeze({ ...parsed.data.values });
      for (const listener of [...listeners]) {
        try {
          listener(values);
        } catch {
        }
      }
    },
    revokePermission: (permission2) => {
      if (permission2 === "settings:plugin") {
        allowed = false;
        values = Object.freeze({});
        listeners.clear();
      }
    }
  };
}
var sameResidency = (left, right) => left.requested === right.requested && left.level === right.level && left.reason === right.reason;
var frozenResidency = (value) => Object.freeze({ requested: value.requested, level: value.level, reason: value.reason });
function createExternalResidency(initial) {
  let current = frozenResidency(initial ?? BACKEND_RESIDENCY_UNREQUESTED);
  const listeners = /* @__PURE__ */ new Set();
  const api = Object.freeze({
    current: () => current,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  });
  return {
    api,
    apply: (raw) => {
      const parsed = ExternalResidencyMessageSchema.safeParse(raw);
      if (!parsed.success || sameResidency(parsed.data.residency, current)) return;
      current = frozenResidency(parsed.data.residency);
      for (const listener of [...listeners]) {
        try {
          listener(current);
        } catch {
        }
      }
    }
  };
}
var UNREQUESTED_RESIDENCY_API = createExternalResidency(void 0).api;
function createExternalContext(init, hostApi, settings, links, residency) {
  const fields = {
    pluginId: init.pluginId,
    dataDir: init.dataDir,
    assetPacks: Object.freeze({ ...init.assetPacks }),
    allowAddons: init.allowAddons,
    host: hostApi.api,
    processHelper: hostApi.processHelpers,
    settings,
    capabilities: hostApi.capabilities,
    ...links === void 0 ? {} : { links }
  };
  const context = Object.defineProperty(fields, "residency", { value: residency ?? UNREQUESTED_RESIDENCY_API, enumerable: residency !== void 0 });
  return Object.freeze(context);
}

var randomUUID = () => globalThis.crypto.randomUUID();

var BACKLOG_EVENTS = 256;
var AI_COMPLETE_HOST_TIMEOUT_MS = 31e4;
var AI = PLUGIN_HOST_DATA_CAPABILITIES.aiChat;
var AI_METHODS = PLUGIN_HOST_DATA_METHODS.aiChat;
var SECRETS = PLUGIN_HOST_DATA_CAPABILITIES.secrets;
var SECRET_METHODS = PLUGIN_HOST_DATA_METHODS.secrets;
var failure3 = (code2) => Object.assign(new Error(`host request failed: ${code2}`), { code: code2 });
var invalid = () => Object.assign(new Error("host response invalid"), { code: "plugin_host_response_invalid" });
function createHostServices(call) {
  const feeds = /* @__PURE__ */ new Map();
  const aiCall = async (method2, request, parse, timeoutMs) => {
    const envelope3 = await call(AI, method2, [request], (value) => AiChatEnvelopeSchema.parse(value), false, timeoutMs);
    if (!envelope3.ok) throw failure3(envelope3.error);
    try {
      return parse(envelope3.value);
    } catch {
      throw invalid();
    }
  };
  const aiOpen = async (method2, request, build) => {
    const result = await call(AI, method2, [request], (value) => {
      const envelope3 = AiChatEnvelopeSchema.parse(value);
      return envelope3.ok ? { ok: true, session: build(envelope3.value) } : { ok: false, error: envelope3.error };
    });
    if (!result.ok) throw failure3(result.error);
    return result.session;
  };
  const secretCall = async (method2, args, parse) => {
    const envelope3 = await call(SECRETS, method2, args, (value) => PluginCoreEnvelopeSchema.parse(value));
    if (!envelope3.ok) throw failure3(envelope3.error);
    try {
      return parse(envelope3.value);
    } catch {
      throw invalid();
    }
  };
  const sessionOf = (opened, turn) => {
    const { sessionId: sessionId5 } = opened;
    const feed = { listeners: /* @__PURE__ */ new Set(), backlog: [] };
    feeds.set(sessionId5, feed);
    return Object.freeze({
      sessionId: sessionId5,
      effective: opened.effective,
      turn,
      send: async (input) => {
        const image = input.image === void 0 ? {} : { image: { mime: input.image.mime, dataBase64: Buffer.from(input.image.data).toString("base64") } };
        return aiCall(AI_METHODS.send, { op: "send", sessionId: sessionId5, text: input.text, ...image }, (value) => AiChatSentSchema.parse(value));
      },
      onEvent: (listener) => {
        feed.listeners.add(listener);
        for (const event of feed.backlog.splice(0)) {
          try {
            listener(event);
          } catch {
          }
        }
        return () => {
          feed.listeners.delete(listener);
        };
      },
      interrupt: async () => {
        await aiCall(AI_METHODS.interrupt, { op: "interrupt", sessionId: sessionId5 }, () => void 0);
      },
      close: async () => {
        try {
          await aiCall(AI_METHODS.close, { op: "close", sessionId: sessionId5 }, () => void 0);
        } finally {
          feeds.delete(sessionId5);
        }
      }
    });
  };
  const ai = Object.freeze({
    getOptions: () => aiCall(AI_METHODS.getOptions, { op: "getOptions" }, (value) => AiChatOptionsSchema.parse(value)),
    complete: (input) => {
      if (typeof input !== "object" || input === null) return Promise.reject(Object.assign(new Error("host request invalid"), { code: "plugin_host_request_invalid" }));
      const parsed = AiChatCompleteRequestSchema.safeParse({ op: "complete", ...input });
      if (!parsed.success) return Promise.reject(Object.assign(new Error("host request invalid"), { code: "plugin_host_request_invalid" }));
      const { image, ...request } = parsed.data;
      const wire = { ...request, ...image === void 0 ? {} : { image: { mime: image.mime, dataBase64: Buffer.from(image.data).toString("base64") } } };
      return aiCall(AI_METHODS.complete, wire, (value) => AiChatCompleteResultSchema.parse(value), AI_COMPLETE_HOST_TIMEOUT_MS);
    },
    openSession: (options) => {
      if (typeof options !== "object" || options === null) return Promise.reject(Object.assign(new Error("host request invalid"), { code: "plugin_host_request_invalid" }));
      if (options.resume !== void 0) {
        return aiOpen(AI_METHODS.attachSession, { op: "attachSession", sessionId: options.resume, ...options.taskId === void 0 ? {} : { taskId: options.taskId } }, (value) => {
          const attached = AiChatAttachedSchema.parse(value);
          return sessionOf(attached, attached.turn);
        });
      }
      const { taskId, providerId: providerId3, modelId: modelId3, effort: effort2, system, transcript } = options;
      const request = { op: "openSession", system, ...taskId === void 0 ? {} : { taskId }, ...providerId3 === void 0 ? {} : { providerId: providerId3 }, ...modelId3 === void 0 ? {} : { modelId: modelId3 }, ...effort2 === void 0 ? {} : { effort: effort2 }, ...transcript === void 0 ? {} : { transcript } };
      return aiOpen(AI_METHODS.openSession, request, (value) => sessionOf(AiChatOpenedSchema.parse(value), null));
    }
  });
  const secrets = Object.freeze({
    get: (name) => secretCall(SECRET_METHODS.get, [name], (value) => {
      if (value !== null && typeof value !== "string") throw invalid();
      return value;
    }),
    set: (name, value) => secretCall(SECRET_METHODS.set, [name, value], () => void 0),
    remove: (name) => secretCall(SECRET_METHODS.remove, [name], () => void 0),
    list: () => secretCall(SECRET_METHODS.list, [], (value) => {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw invalid();
      return value;
    }),
    available: () => secretCall(SECRET_METHODS.available, [], (value) => {
      if (typeof value !== "boolean") throw invalid();
      return value;
    })
  });
  return {
    ai,
    secrets,
    receiveAiEvent(value) {
      const parsed = AiChatBackendEventV1Schema.safeParse(value);
      if (!parsed.success) return false;
      const feed = feeds.get(parsed.data.sessionId);
      if (feed === void 0) return true;
      const body = parsed.data.turn;
      const event = { turnId: parsed.data.turnId, ...body };
      if (feed.listeners.size === 0) {
        feed.backlog.push(event);
        if (feed.backlog.length > BACKLOG_EVENTS) feed.backlog.shift();
      } else {
        for (const listener of [...feed.listeners]) {
          try {
            listener(event);
          } catch {
          }
        }
      }
      if (event.kind === "failed" && event.code === "access_revoked") feeds.delete(parsed.data.sessionId);
      return true;
    },
    dispose() {
      feeds.clear();
    }
  };
}

function createPluginHostApiClient(transport) {
  const pending = /* @__PURE__ */ new Map();
  const listeners = /* @__PURE__ */ new Set();
  const capabilityListeners = /* @__PURE__ */ new Set();
  const snapshots = /* @__PURE__ */ new Map();
  const timeoutMs = transport.timeoutMs ?? 3e4;
  const helperCall2 = (helperId, raw) => new Promise((resolve, reject) => {
    const request = PluginProcessHelperRequestV1Schema.safeParse(raw);
    if (!request.success || !/^[a-z][a-z0-9-]{0,47}$/.test(helperId)) {
      reject(Object.assign(new Error("helper request invalid"), { code: "plugin_helper_request_invalid" }));
      return;
    }
    const requestId5 = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId5);
      reject(Object.assign(new Error("helper request timed out"), { code: "plugin_helper_timeout" }));
    }, Math.min(timeoutMs, 3e4));
    pending.set(requestId5, { resolve, reject, timer, allowRetryAfter: false });
    try {
      transport.send({ protocolVersion: 1, requestId: requestId5, kind: "process-helper-call", pluginId: transport.pluginId, helperId, request: request.data });
    } catch {
      clearTimeout(timer);
      pending.delete(requestId5);
      reject(Object.assign(new Error("helper unavailable"), { code: "plugin_helper_unavailable" }));
    }
  });
  const processHelpers = Object.freeze({
    openBundledHelper: async (helperId) => {
      PluginProcessHelperResponseV1Schema.parse(await helperCall2(helperId, { op: "open", helperId }));
    },
    write: async (helperId, bytes4) => {
      if (!(bytes4 instanceof Uint8Array) || bytes4.byteLength < 1 || bytes4.byteLength > PROCESS_HELPER_LIMITS.frameBytes) throw Object.assign(new Error("helper frame size invalid"), { code: "plugin_helper_request_invalid" });
      PluginProcessHelperResponseV1Schema.parse(await helperCall2(helperId, { op: "write", helperId, bytes: Buffer.from(bytes4).toString("base64") }));
    },
    read: async (helperId, maxBytes = PROCESS_HELPER_LIMITS.frameBytes) => {
      const result = PluginProcessHelperResponseV1Schema.parse(await helperCall2(helperId, { op: "read", helperId, maxBytes }));
      if (result.state === "closed") throw Object.assign(new Error("plugin helper closed"), { code: "plugin_helper_unavailable" });
      return result.state === "data" ? new Uint8Array(Buffer.from(result.bytes, "base64")) : null;
    },
    close: async (helperId) => {
      PluginProcessHelperResponseV1Schema.parse(await helperCall2(helperId, { op: "close", helperId }));
    }
  });
  const call = (capabilityId2, method2, args, parse, allowRetryAfter = false, timeoutOverrideMs) => new Promise((resolve, reject) => {
    const requestId5 = randomUUID();
    const request = PluginHostDataRequestV1Schema.safeParse({ protocolVersion: 1, requestId: requestId5, kind: "capability-call", pluginId: transport.pluginId, capabilityId: capabilityId2, method: method2, args });
    if (!request.success) {
      reject(Object.assign(new Error("host request invalid"), { code: "plugin_host_request_invalid" }));
      return;
    }
    const requestTimeout = timeoutOverrideMs === void 0 ? timeoutMs : Math.min(timeoutOverrideMs, AI_COMPLETE_HOST_TIMEOUT_MS);
    const timer = setTimeout(() => {
      pending.delete(requestId5);
      reject(Object.assign(new Error("host request timed out"), { code: "plugin_host_timeout" }));
    }, requestTimeout);
    pending.set(requestId5, { resolve: (value) => {
      try {
        resolve(parse(value));
      } catch {
        reject(Object.assign(new Error("host response invalid"), { code: "plugin_host_response_invalid" }));
      }
    }, reject, timer, allowRetryAfter });
    try {
      transport.send(request.data);
    } catch {
      clearTimeout(timer);
      pending.delete(requestId5);
      reject(Object.assign(new Error("host unavailable"), { code: "plugin_host_unavailable" }));
    }
  });
  const page3 = async (capabilityId2, method2, request, schema) => {
    const expected = request.snapshotId === void 0 ? void 0 : snapshots.get(request.snapshotId);
    if (request.snapshotId !== void 0 && expected === void 0) throw Object.assign(new Error("snapshot not opened by this plugin host client"), { code: "plugin_host_snapshot_invalid" });
    const result = await call(capabilityId2, method2, [request], (value) => schema.parse(value));
    const actual = result.snapshot;
    if (expected !== void 0 && (actual.snapshotId !== expected.snapshotId || actual.generation !== expected.generation || actual.highWatermark !== expected.highWatermark)) throw Object.assign(new Error("snapshot changed during paging"), { code: "plugin_host_snapshot_mismatch" });
    snapshots.set(actual.snapshotId, actual);
    while (snapshots.size > 128) snapshots.delete(snapshots.keys().next().value);
    return result;
  };
  const services = createHostServices(call);
  const capabilityHost = Object.freeze({
    list: () => call(PLUGIN_HOST_DATA_CAPABILITIES.capabilityControl, PLUGIN_HOST_DATA_METHODS.capabilityControl.list, [], (value) => LinkCapabilityEntryListSchema.parse(value)),
    openLink: (category, request = {}) => {
      const parsed = OpenLinkCallSchema.parse({ ...request, category });
      return call(PLUGIN_HOST_DATA_CAPABILITIES.capabilityControl, PLUGIN_HOST_DATA_METHODS.capabilityControl.openLink, [parsed], (value) => LinkTicketSchema.parse(value), true);
    },
    onChange: (listener) => {
      capabilityListeners.add(listener);
      return () => {
        capabilityListeners.delete(listener);
      };
    }
  });
  const capabilities = capabilityHost;
  const api = Object.freeze({
    ai: services.ai,
    secrets: services.secrets,
    program: Object.freeze({
      call: (operation, input, options) => {
        const request = { apiVersion: 1, requestId: options?.requestId ?? randomUUID(), operation, input };
        return call(PLUGIN_HOST_DATA_CAPABILITIES.programApi, PLUGIN_HOST_DATA_METHODS.programApi.call, [request], (value) => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Program reply envelope is invalid");
          const reply = value;
          if (reply.apiVersion !== 1 || reply.requestId !== request.requestId || reply.operation !== operation || typeof reply.ok !== "boolean") throw new TypeError("Program reply correlation is invalid");
          return value;
        });
      }
    }),
    workRecords: Object.freeze({
      readPage: (request) => page3(PLUGIN_HOST_DATA_CAPABILITIES.workRecords, PLUGIN_HOST_DATA_METHODS.workRecords.readPage, request, PluginHostWorkRecordPageV1Schema),
      subscribeSettledChanges: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }
    }),
    agentDirectory: Object.freeze({
      readPage: (request) => page3(PLUGIN_HOST_DATA_CAPABILITIES.agentDirectory, PLUGIN_HOST_DATA_METHODS.agentDirectory.readPage, request, PluginHostAgentPageV1Schema)
    }),
    projectDirectory: Object.freeze({
      readPage: (request) => page3(PLUGIN_HOST_DATA_CAPABILITIES.projectDirectory, PLUGIN_HOST_DATA_METHODS.projectDirectory.readPage, request, PluginHostProjectPageV1Schema)
    }),
    pluginState: Object.freeze({
      readPage: (namespace, cursor4, limit) => call(PLUGIN_HOST_DATA_CAPABILITIES.pluginState, PLUGIN_HOST_DATA_METHODS.pluginState.readPage, [namespace, cursor4, limit], (value) => PluginStateReadPageV1Schema.parse(value)),
      writeBatch: async (namespace, records) => {
        PluginStateBatchResultV1Schema.parse(await call(PLUGIN_HOST_DATA_CAPABILITIES.pluginState, PLUGIN_HOST_DATA_METHODS.pluginState.writeBatch, [namespace, records], (value) => value));
      },
      deleteBatch: async (namespace, keys) => {
        PluginStateBatchResultV1Schema.parse(await call(PLUGIN_HOST_DATA_CAPABILITIES.pluginState, PLUGIN_HOST_DATA_METHODS.pluginState.deleteBatch, [namespace, keys], (value) => value));
      }
    })
  });
  return {
    api,
    capabilities,
    processHelpers,
    receive(value) {
      if (services.receiveAiEvent(value)) return true;
      const capabilityEvent = LinkCapabilityEventSchema.safeParse(value);
      if (capabilityEvent.success) {
        for (const listener of [...capabilityListeners]) {
          try {
            listener(capabilityEvent.data);
          } catch {
          }
        }
        return true;
      }
      const changed = PluginHostWorkChangedEventV1Schema.safeParse(value);
      if (changed.success) {
        for (const listener of [...listeners]) {
          try {
            listener(changed.data);
          } catch {
          }
        }
        return true;
      }
      const response = HostResponseEnvelopeV1Schema.safeParse(value);
      if (!response.success) return false;
      const waiter = pending.get(response.data.requestId);
      if (waiter === void 0) return true;
      pending.delete(response.data.requestId);
      clearTimeout(waiter.timer);
      if (response.data.ok) waiter.resolve(response.data.value);
      else waiter.reject(Object.assign(new Error(response.data.error.message), { code: response.data.error.code, ...waiter.allowRetryAfter && response.data.error.retryAfterMs !== void 0 ? { retryAfterMs: response.data.error.retryAfterMs } : {} }));
      return true;
    },
    revokePermission(permission2) {
      if (permission2 === "work-records:read") listeners.clear();
    },
    dispose() {
      for (const [requestId5, waiter] of pending) {
        clearTimeout(waiter.timer);
        waiter.reject(Object.assign(new Error("host client disposed"), { code: "plugin_host_unavailable" }));
        pending.delete(requestId5);
      }
      listeners.clear();
      capabilityListeners.clear();
      snapshots.clear();
      services.dispose();
    }
  };
}

var TestHostNotModeled = class extends Error {
  surface;
  id;
  reason;
  constructor(surface, id7, reason3 = null) {
    super(`TestHostNotModeled: ${surface} ${id7} is not modeled by this devkit test host version${reason3 === null ? "" : `: ${reason3}`}`);
    this.name = "TestHostNotModeled";
    this.surface = surface;
    this.id = id7;
    this.reason = reason3;
  }
};
var TestHostRefused = class extends Error {
  constructor(message) {
    super(`TestHostRefused: ${message}`);
    this.name = "TestHostRefused";
  }
};
var TestHostInvalid = class extends Error {
  issues;
  constructor(subject, issues) {
    super(`TestHostInvalid: ${subject}: ${issues.join("; ")}`);
    this.name = "TestHostInvalid";
    this.issues = issues;
  }
};

function createManualClock(start = Date.UTC(2026, 9, 26, 0, 0, 0)) {
  let current = start;
  let sequence = 0;
  const timers = /* @__PURE__ */ new Map();
  const nextDue = (limit) => {
    let found;
    for (const entry2 of timers) {
      if (entry2[1].due > limit) continue;
      if (found === void 0 || entry2[1].due < found[1].due || entry2[1].due === found[1].due && entry2[0] < found[0]) found = entry2;
    }
    return found;
  };
  return {
    now: () => current,
    later: (run, ms) => {
      if (!Number.isInteger(ms) || ms < 0) throw new TestHostInvalid("clock.later", ["delay must be a non-negative integer number of milliseconds"]);
      const id7 = ++sequence;
      timers.set(id7, { due: current + ms, run });
      return { cancel: () => {
        timers.delete(id7);
      } };
    },
    advance: (ms) => {
      if (!Number.isInteger(ms) || ms < 0) throw new TestHostInvalid("clock.advance", ["step must be a non-negative integer number of milliseconds"]);
      const target = current + ms;
      let due = nextDue(target);
      while (due !== void 0) {
        const [id7, timer] = due;
        timers.delete(id7);
        current = timer.due;
        timer.run();
        due = nextDue(target);
      }
      current = target;
    }
  };
}

function loadTestManifest(raw) {
  const parsed = PluginManifestV2Schema.safeParse(raw);
  if (!parsed.success) {
    throw new TestHostInvalid("manifest", parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`));
  }
  return parsed.data;
}
function isRevocablePermission(permission2) {
  return REVOCABLE_PLUGIN_EXACT_PERMISSIONS.includes(permission2) || REVOCABLE_PLUGIN_PERMISSION_PREFIXES.some((prefix) => permission2.startsWith(prefix));
}

function createTaskDirectory(initial = []) {
  const tasks = new Set(initial);
  return {
    exists: (taskId) => tasks.has(taskId),
    add: (taskId) => {
      tasks.add(taskId);
    },
    remove: (taskId) => tasks.delete(taskId)
  };
}

function createGrantTable(declared, initial) {
  for (const permission2 of initial) {
    if (!declared.includes(permission2)) throw new TestHostRefused(`${permission2} is not declared in the manifest`);
  }
  const granted = new Set(initial);
  return {
    has: (permission2) => granted.has(permission2),
    grant: (permission2) => {
      if (!declared.includes(permission2)) throw new TestHostRefused(`${permission2} is not declared in the manifest`);
      granted.add(permission2);
    },
    revoke: (permission2) => {
      if (!isRevocablePermission(permission2)) throw new TestHostRefused(`${permission2} is not revocable`);
      return granted.delete(permission2);
    },
    list: () => [...granted]
  };
}

var TERMINAL = ["completed", "interrupted", "failed"];
function compileEntry(entry2) {
  if (entry2 === "completed") return { kind: "completed" };
  if (entry2 === "interrupted") return { kind: "interrupted" };
  if (typeof entry2 === "object" && entry2 !== null) {
    if ("textDelta" in entry2) return { kind: "textDelta", text: entry2.textDelta };
    if ("contentSaved" in entry2) return { kind: "contentSaved", sequenceNo: entry2.contentSaved };
    if ("failed" in entry2) {
      const failed = entry2.failed;
      return {
        kind: "failed",
        code: failed.code,
        retryable: failed.retryable ?? failed.code !== "access_revoked",
        fallbackUsed: failed.fallbackUsed ?? false,
        partialDelivered: failed.partialDelivered ?? false
      };
    }
  }
  throw new TestHostInvalid("ai script", [`unsupported script entry ${JSON.stringify(entry2)}`]);
}
function compileAiScript(input) {
  const entries = Array.isArray(input) ? input : input.events;
  if (!Array.isArray(entries)) throw new TestHostInvalid("ai script", ["events must be an array"]);
  const compiled = entries.map((entry2) => {
    const event = compileEntry(entry2);
    const parsed = AiChatTurnEventSchema.safeParse(event);
    if (!parsed.success) throw new TestHostInvalid("ai script", parsed.error.issues.map((issue) => `${issue.path.join(".") || "(event)"}: ${issue.message}`));
    return parsed.data;
  });
  compiled.forEach((event, index) => {
    if (TERMINAL.includes(event.kind) && index !== compiled.length - 1) {
      throw new TestHostInvalid("ai script", ["a terminal event must be the last entry of the script"]);
    }
  });
  return compiled;
}

var DEFAULT_AI_PROVIDER = {
  id: "scripted",
  label: "Scripted provider",
  state: "ready",
  models: [
    { id: "scripted-text", label: "Scripted text", efforts: ["low", "medium"], defaultEffort: "medium", supportsImages: false, isDefault: true },
    { id: "scripted-vision", label: "Scripted vision", efforts: ["medium"], defaultEffort: "medium", supportsImages: true, isDefault: false }
  ]
};
var ok2 = (value) => ({ ok: true, value });
var fail = (error) => ({ ok: false, error });
var OPERATION = {
  "ai.getOptions": "getOptions",
  "ai.openSession": "openSession",
  "ai.complete": "complete",
  "session.send": "send",
  "session.interrupt": "interrupt",
  "session.close": "close"
};
var knownError = (code2) => {
  if (code2 === "deadline_exceeded") return "turn_timeout";
  if (code2 === "cancelled") return "interrupted";
  if (code2 === "response_unavailable") return "provider_error";
  return AI_CHAT_ERROR_CODES.includes(code2) ? code2 : "unavailable";
};
function createAiRules(deps) {
  const { clock, limits, tasks } = deps;
  let providerState = deps.provider.state;
  const sessions = /* @__PURE__ */ new Map();
  const queue = [];
  const turnTimes = [];
  const counters = { sessionsOpened: 0, turns: 0, imageTurns: 0, failedTurns: 0, rateLimited: 0, inputChars: 0, outputChars: 0, lastTurnAt: null };
  let sessionSequence = 0;
  let turnSequence = 0;
  let activeTurns = 0;
  let quotaUntil = 0;
  let hiddenCredit = null;
  if (deps.provider.models.length === 0) throw new TestHostInvalid("ai provider", ["a provider needs at least one model"]);
  const modelOf = (id7) => deps.provider.models.find((model) => model.id === id7);
  const defaultModel = () => deps.provider.models.find((model) => model.isDefault) ?? deps.provider.models[0];
  const attachedOf = (surface, id7) => {
    const session = sessions.get(id7);
    return session !== void 0 && session.attached && session.surface === surface ? session : void 0;
  };
  const emit = (turn, event) => {
    if (!turn.session.attached) return;
    deps.deliver(turn.session.surface, turn.session.id, turn.id, event);
  };
  const finish = (turn, event, countFailure = true) => {
    if (turn.terminal !== null) return;
    turn.terminal = event;
    turn.timer?.cancel();
    turn.timer = null;
    const session = turn.session;
    if (session.running && session.current === turn) {
      session.running = false;
      activeTurns -= 1;
    }
    if (event.kind === "failed") {
      if (countFailure) counters.failedTurns += 1;
      if (event.code === "quota_exhausted") quotaUntil = clock.now() + limits.quotaCooldownMs;
    }
    emit(turn, event);
    for (const waiter of turn.waiters.splice(0)) waiter(event);
  };
  const closeSession = (session) => {
    if (sessions.get(session.id) !== session) return;
    sessions.delete(session.id);
    if (session.current !== null) {
      session.current.timer?.cancel();
      session.current.timer = null;
    }
    if (session.running) {
      session.running = false;
      activeTurns -= 1;
    }
  };
  const denyAndClose = () => {
    for (const session of [...sessions.values()]) {
      const turn = session.current;
      if (session.running && turn !== null && turn.terminal === null) {
        finish(turn, { kind: "failed", code: "access_revoked", retryable: false, fallbackUsed: false, partialDelivered: turn.text !== "" }, false);
      }
      closeSession(session);
    }
  };
  const recheck = () => {
    if (sessions.size > 0 && deps.authorize() !== null) denyAndClose();
  };
  const createSession = (surface, model, effort2, attached) => {
    sessionSequence += 1;
    const session = {
      id: String(sessionSequence),
      surface,
      attached,
      effective: { providerId: deps.provider.id, modelId: model.id, effort: effort2 },
      supportsImages: model.supportsImages,
      current: null,
      running: false
    };
    sessions.set(session.id, session);
    return session;
  };
  const admit = () => {
    if (sessions.size >= limits.sessionsPerPlugin) return "session_limit";
    if (sessions.size >= limits.sessionsTotal) return "busy";
    return null;
  };
  const quotaRefusal = () => quotaUntil > clock.now() ? "quota_exhausted" : null;
  const rateRefusal = () => {
    const at = clock.now();
    while (turnTimes.length > 0 && at - turnTimes[0] > 36e5) turnTimes.shift();
    const perMinute = turnTimes.filter((time) => at - time <= 6e4).length;
    if (turnTimes.length >= limits.turnsPerHour || perMinute >= limits.turnsPerMinute) {
      counters.rateLimited += 1;
      return "rate_limited";
    }
    return null;
  };
  const hiddenRefusal = (kind) => {
    const input = deps.lastInput();
    if (input === null || clock.now() - input.at > limits.hiddenWindowMs) return "view_not_visible";
    if (hiddenCredit === null || hiddenCredit.seq !== input.seq) {
      hiddenCredit = { seq: input.seq, opens: limits.hiddenOpensPerInput, turns: limits.hiddenTurnsPerInput };
    }
    if (hiddenCredit[kind] <= 0) {
      counters.rateLimited += 1;
      return "rate_limited";
    }
    return null;
  };
  const spendHidden = (kind) => {
    if (hiddenCredit !== null) hiddenCredit[kind] -= 1;
  };
  const accept = (text6, hasImage) => {
    const at = clock.now();
    turnTimes.push(at);
    counters.turns += 1;
    counters.inputChars += text6.length;
    if (hasImage) counters.imageTurns += 1;
    counters.lastTurnAt = new Date(at).toISOString();
  };
  const startTurn = (session) => {
    turnSequence += 1;
    const turn = { id: turnSequence.toString(16).padStart(16, "0"), session, text: "", terminal: null, timer: null, waiters: [] };
    session.current = turn;
    session.running = true;
    activeTurns += 1;
    turn.timer = clock.later(() => {
      finish(turn, { kind: "failed", code: "turn_timeout", retryable: true, fallbackUsed: false, partialDelivered: turn.text !== "" });
    }, limits.turnTimeoutMs);
    emit(turn, { kind: "started" });
    return turn;
  };
  const runEvents = (turn, events) => {
    for (const event of events) {
      if (turn.terminal !== null) return;
      if (event.kind === "textDelta") {
        turn.text += event.text;
        counters.outputChars += event.text.length;
        emit(turn, event);
        if (turn.text.length > limits.replyChars) {
          finish(turn, { kind: "failed", code: "reply_too_long", retryable: true, fallbackUsed: false, partialDelivered: true });
        }
        continue;
      }
      if (event.kind === "contentSaved") {
        emit(turn, event);
        continue;
      }
      finish(turn, event);
    }
  };
  const nextScript = () => queue.shift() ?? [{ kind: "completed" }];
  const optionsView = () => {
    const at = clock.now();
    const exhausted = quotaUntil > at;
    return {
      providers: [{
        id: deps.provider.id,
        label: deps.provider.label,
        state: providerState,
        models: deps.provider.models.map((model) => ({ id: model.id, label: model.label, efforts: [...model.efforts], defaultEffort: model.defaultEffort, supportsImages: model.supportsImages, isDefault: model.isDefault }))
      }],
      defaultProviderId: deps.provider.id,
      limits: {
        systemChars: limits.systemChars,
        transcriptLines: limits.transcriptLines,
        transcriptChars: limits.transcriptChars,
        inputChars: limits.inputChars,
        imageBytes: limits.imageBytes,
        turnsPerMinute: limits.turnsPerMinute
      },
      quota: { state: exhausted ? "exhausted" : "ok", retryAfterMs: exhausted ? quotaUntil - at : null }
    };
  };
  const openSession = (surface, request) => {
    const providerId3 = request.providerId ?? deps.provider.id;
    if (providerId3 !== deps.provider.id) return fail("provider_not_found");
    if (request.transcript !== void 0 && request.transcript.reduce((sum, line2) => sum + line2.text.length, 0) > limits.transcriptChars) return fail("input_too_large");
    if (providerState !== "ready") return fail("provider_not_ready");
    if (request.modelId !== void 0 && modelOf(request.modelId) === void 0) return fail("model_unavailable");
    const model = request.modelId === void 0 ? defaultModel() : modelOf(request.modelId) ?? defaultModel();
    if (request.effort !== void 0 && !model.efforts.includes(request.effort)) return fail("model_unavailable");
    const hidden = surface === "view" && !deps.visible();
    if (hidden) {
      const refusal = hiddenRefusal("opens");
      if (refusal !== null) return fail(refusal);
    }
    const full = admit();
    if (full !== null) return fail(full);
    if (request.taskId !== void 0 && !tasks.exists(request.taskId)) return fail("task_not_found");
    if (hidden) spendHidden("opens");
    const session = createSession(surface, model, request.effort ?? model.defaultEffort, true);
    counters.sessionsOpened += 1;
    return ok2({ sessionId: session.id, effective: session.effective });
  };
  const complete = async (surface, request) => {
    const existing = request.sessionId === void 0 ? void 0 : sessions.get(request.sessionId);
    if (request.sessionId !== void 0 && existing === void 0) return fail("session_not_found");
    const hidden = surface === "view" && !deps.visible();
    const hiddenOpen = hidden && existing === void 0;
    if (hiddenOpen) {
      const refusal = hiddenRefusal("opens");
      if (refusal !== null) return fail(refusal);
    }
    if (hidden) {
      const refusal = hiddenRefusal("turns");
      if (refusal !== null) return fail(refusal);
    }
    const providerId3 = existing?.effective.providerId ?? request.providerId ?? deps.provider.id;
    if (providerId3 !== deps.provider.id) return fail("provider_not_found");
    if (providerState !== "ready") return fail("provider_not_ready");
    const modelId3 = request.modelId ?? existing?.effective.modelId;
    const found = modelId3 === void 0 ? void 0 : modelOf(modelId3);
    if (request.modelId !== void 0 && found === void 0) return fail("model_unavailable");
    const selected = found ?? defaultModel();
    if (request.effort !== void 0 && !selected.efforts.includes(request.effort)) return fail("model_unavailable");
    const supportsImages = request.modelId === void 0 && existing !== void 0 ? existing.supportsImages : selected.supportsImages;
    if (request.image !== void 0 && !supportsImages) return fail("unsupported_image");
    if (existing === void 0) {
      const full = admit();
      if (full !== null) return fail(full);
    }
    const quota = quotaRefusal();
    if (quota !== null) return fail(quota);
    const rate = rateRefusal();
    if (rate !== null) return fail(rate);
    if (existing?.running) return fail("turn_in_progress");
    if (activeTurns >= limits.concurrentTurnsTotal) return fail("busy");
    if (existing === void 0 && request.taskId !== void 0 && !tasks.exists(request.taskId)) return fail("task_not_found");
    const session = existing ?? createSession(surface, selected, request.effort ?? selected.defaultEffort, false);
    if (existing === void 0) counters.sessionsOpened += 1;
    if (hiddenOpen) spendHidden("opens");
    accept(request.text, request.image !== void 0);
    if (hidden) spendHidden("turns");
    const turn = startTurn(session);
    runEvents(turn, nextScript());
    const outcome2 = turn.terminal ?? await new Promise((resolve) => {
      turn.waiters.push(resolve);
    });
    if (existing === void 0) closeSession(session);
    if (outcome2.kind === "completed") {
      return ok2({ sessionId: session.id, requestId: `plugin:${session.id}:${turn.id}`, text: turn.text, providerTurnId: null, historySaved: "saved" });
    }
    if (outcome2.kind === "failed") return fail(outcome2.code === "access_revoked" ? "interrupted" : knownError(outcome2.code));
    return fail(outcome2.kind === "interrupted" ? "interrupted" : "unavailable");
  };
  const send = (surface, request) => {
    const session = attachedOf(surface, request.sessionId);
    if (session === void 0) return fail("session_not_found");
    const hidden = surface === "view" && !deps.visible();
    if (hidden) {
      const refusal = hiddenRefusal("turns");
      if (refusal !== null) return fail(refusal);
    }
    if (session.running) return fail("turn_in_progress");
    const quota = quotaRefusal();
    if (quota !== null) return fail(quota);
    if (request.image !== void 0 && !session.supportsImages) return fail("unsupported_image");
    const rate = rateRefusal();
    if (rate !== null) return fail(rate);
    if (activeTurns >= limits.concurrentTurnsTotal) return fail("busy");
    accept(request.text, request.image !== void 0);
    if (hidden) spendHidden("turns");
    const turn = startTurn(session);
    runEvents(turn, nextScript());
    return ok2({ turnId: turn.id });
  };
  const interrupt = (surface, request) => {
    const session = attachedOf(surface, request.sessionId);
    if (session === void 0) return fail("session_not_found");
    const turn = session.current;
    if (!session.running || turn === null) return ok2(true);
    finish(turn, { kind: "interrupted" });
    return ok2(true);
  };
  const close = (surface, request) => {
    const session = attachedOf(surface, request.sessionId);
    if (session === void 0) return fail("session_not_found");
    closeSession(session);
    return ok2(true);
  };
  const guarded = (id7, run) => ({
    id: id7,
    errorCodes: AI_CHAT_ERROR_CODES,
    handle: async (surface, args) => {
      const parsed = AiChatRequestSchema.safeParse(args);
      if (!parsed.success || parsed.data.op !== OPERATION[id7]) return fail("request_invalid");
      const denied = deps.authorize();
      if (denied !== null) {
        denyAndClose();
        return fail(denied);
      }
      return run(surface, parsed.data);
    }
  });
  const onEvent = {
    id: "session.onEvent",
    errorCodes: [],
    handle: async (surface, args) => {
      const sessionId5 = typeof args === "object" && args !== null && "sessionId" in args ? args.sessionId : void 0;
      const parsed = AiChatSessionIdSchema.safeParse(sessionId5);
      if (!parsed.success) return fail("request_invalid");
      const denied = deps.authorize();
      if (denied !== null) {
        denyAndClose();
        return fail(denied);
      }
      return attachedOf(surface, parsed.data) === void 0 ? fail("session_not_found") : ok2(true);
    }
  };
  const endpoints = [
    guarded("ai.getOptions", () => ok2(optionsView())),
    guarded("ai.openSession", (surface, request) => openSession(surface, request)),
    guarded("ai.complete", (surface, request) => complete(surface, request)),
    guarded("session.send", (surface, request) => send(surface, request)),
    guarded("session.interrupt", (surface, request) => interrupt(surface, request)),
    guarded("session.close", (surface, request) => close(surface, request)),
    onEvent
  ];
  const usage = () => ({
    activeSessions: sessions.size,
    sessionsOpened: counters.sessionsOpened,
    turns: counters.turns,
    imageTurns: counters.imageTurns,
    failedTurns: counters.failedTurns,
    rateLimited: counters.rateLimited,
    inputChars: counters.inputChars,
    outputChars: counters.outputChars,
    lastTurnAt: counters.lastTurnAt
  });
  return {
    endpoints,
    recheck,
    controls: {
      next: (script) => {
        queue.push(compileAiScript(script));
      },
      setProviderState: (state2) => {
        providerState = state2;
      },
      usage,
      openSessions: () => [...sessions.keys()]
    }
  };
}

function branchOf(union, tag) {
  const branch = union.optionsMap.get(tag);
  if (branch === void 0) throw new Error(`union has no branch '${String(tag)}'`);
  return branch;
}
function fieldOf(schema, key4) {
  const field = schema instanceof external_exports.ZodObject ? schema.shape[key4] : void 0;
  if (field === void 0) throw new Error(`schema has no field '${key4}'`);
  return field;
}

var size = external_exports.number().int().nonnegative();
var entryKind = external_exports.enum(["file", "directory"]);
var StorageReadInputSchema = branchOf(PluginStorageRequestSchema, "read");
var StorageReadOutputSchema = external_exports.instanceof(Uint8Array);
var StorageReadTextInputSchema = StorageReadInputSchema.pick({ op: true, path: true });
var StorageReadTextOutputSchema = external_exports.string();
var StorageWriteInputSchema = branchOf(PluginStorageRequestSchema, "write");
var StorageWriteOutputSchema = external_exports.object({ size }).strict();
var StorageListInputSchema = branchOf(PluginStorageRequestSchema, "list");
var StorageListOutputSchema = external_exports.array(external_exports.object({ name: external_exports.string(), kind: entryKind, size }).strict());
var StorageStatInputSchema = branchOf(PluginStorageRequestSchema, "stat");
var StorageStatOutputSchema = external_exports.object({ kind: entryKind, size, modifiedMs: external_exports.number().nonnegative() }).strict().nullable();
var StorageRemoveInputSchema = branchOf(PluginStorageRequestSchema, "remove");
var StorageRemoveOutputSchema = external_exports.object({ removed: external_exports.boolean() }).strict();
var SettingsGetInputSchema = branchOf(PluginSettingsRequestSchema, "get");
var SettingsSetInputSchema = branchOf(PluginSettingsRequestSchema, "set");
var SettingsRemoveInputSchema = branchOf(PluginSettingsRequestSchema, "remove");
var SettingsAllInputSchema = branchOf(PluginSettingsRequestSchema, "all");
var SettingsKeySchema = fieldOf(SettingsGetInputSchema, "key");
var SettingsValueSchema = fieldOf(SettingsSetInputSchema, "value");
var SettingsValuesSchema = external_exports.record(external_exports.string(), SettingsValueSchema);
var SettingsWriteOutputSchema = external_exports.literal(true);
var SecretsGetInputSchema = branchOf(PluginSecretsRequestSchema, "get");
var SecretsSetInputSchema = branchOf(PluginSecretsRequestSchema, "set");
var SecretsRemoveInputSchema = branchOf(PluginSecretsRequestSchema, "remove");
var SecretsListInputSchema = branchOf(PluginSecretsRequestSchema, "list");
var SecretsAvailableInputSchema = branchOf(PluginSecretsRequestSchema, "available");
var SecretNameSchema = fieldOf(SecretsGetInputSchema, "name");
var SecretValueSchema = fieldOf(SecretsSetInputSchema, "value");
var SecretNamesSchema = external_exports.array(SecretNameSchema);
var SecretsAvailableSchema = external_exports.boolean();
var SecretsWriteOutputSchema = external_exports.literal(true);
var InputProvideInputSchema = branchOf(PluginInputRequestSchema, "provide");
var InputStopInputSchema = branchOf(PluginInputRequestSchema, "stop");
var InputSetSpeakingInputSchema = branchOf(PluginInputRequestSchema, "setSpeaking");
var InputStateInputSchema = branchOf(PluginInputRequestSchema, "state");
var InputStateOutputSchema = PluginInputOwnStateSchema;

var WorkRecordsPageRequestSchema = PluginDataPageRequestV1Schema;
var WorkRecordsPageSchema = PluginHostWorkRecordPageV1Schema;
var WorkRecordsSettledChangeSchema = PluginHostWorkChangedEventV1Schema;
var DirectoryPageRequestSchema = PluginDataPageRequestV1Schema;
var AgentDirectoryPageSchema = PluginHostAgentPageV1Schema;
var ProjectDirectoryPageSchema = PluginHostProjectPageV1Schema;
var PluginStateReadPageInputSchema = external_exports.object({
  namespace: PluginStateRecordV1Schema.shape.key,
  cursor: PluginDataPageRequestV1Schema.shape.cursor,
  limit: PluginDataPageRequestV1Schema.shape.limit
}).strict();
var PluginStatePageSchema = PluginStateReadPageV1Schema;
var ProcessHelperIdSchema = PluginProcessHelperDeclarationV1Schema.shape.id;
var ProcessHelperWriteInputSchema = external_exports.object({
  helperId: ProcessHelperIdSchema,
  bytes: external_exports.instanceof(Uint8Array).refine((bytes4) => bytes4.byteLength >= 1 && bytes4.byteLength <= PROCESS_HELPER_LIMITS.frameBytes)
}).strict();
var ProcessHelperReadInputSchema = external_exports.object({
  helperId: ProcessHelperIdSchema,
  maxBytes: external_exports.number().int().min(1).max(PROCESS_HELPER_LIMITS.frameBytes).optional()
}).strict();
var ProcessHelperReadOutputSchema = external_exports.instanceof(Uint8Array).nullable();
var BackendSecretsSetInputSchema = external_exports.object({ name: SecretNameSchema, value: SecretValueSchema }).strict();

var requests = AiChatRequestSchema.innerType();
var turnId2 = fieldOf(AiChatViewEventSchema, "turnId");
var turnEvents = AiChatTurnEventSchema.options.map((option) => option.extend({ turnId: turnId2 }));
var AiGetOptionsInputSchema = branchOf(requests, "getOptions");
var AiOptionsSchema = AiChatOptionsSchema;
var AiCompleteInputSchema = AiChatCompleteRequestSchema;
var AiCompleteOutputSchema = AiChatCompleteResultSchema;
var BackendAiCompleteInputSchema = external_exports.union([
  AiChatCompleteFreshRequestSchema.omit({ op: true }),
  AiChatCompleteExistingRequestSchema.omit({ op: true })
]).refine((value) => value.text.trim() !== "" || value.image !== void 0, { message: "a turn needs text or an image" });
var BackendAiCompleteOutputSchema = AiChatCompleteResultSchema;
var openSessionInput = branchOf(requests, "openSession").extend({ resume: fieldOf(branchOf(requests, "attachSession"), "sessionId").optional() });
var AiOpenSessionInputSchema = openSessionInput;
var AiOpenSessionOutputSchema = external_exports.union([AiChatOpenedSchema, AiChatAttachedSchema]);
var SessionSendInputSchema = branchOf(requests, "send");
var SessionSendOutputSchema = AiChatSentSchema;
var SessionInterruptInputSchema = branchOf(requests, "interrupt");
var SessionCloseInputSchema = branchOf(requests, "close");
var SessionEventSchema = external_exports.discriminatedUnion("kind", turnEvents);
var BackendAiOpenSessionInputSchema = external_exports.union([openSessionInput.omit({ op: true }), external_exports.object({ resume: fieldOf(SessionInterruptInputSchema, "sessionId"), taskId: fieldOf(openSessionInput, "taskId") }).strict()]);
var BackendAiOpenSessionOutputSchema = external_exports.union([AiChatOpenedSchema, AiChatAttachedSchema]);
var BackendSessionSendInputSchema = SessionSendInputSchema.omit({ op: true, sessionId: true });

var capabilityCall = (capability, method2) => ({ host: "capability-call", method: `${PLUGIN_HOST_DATA_CAPABILITIES[capability]}/${String(PLUGIN_HOST_DATA_METHODS[capability][method2])}` });
var helperCall = (op) => ({ host: "process-helper-call", method: op });
var SETTINGS_IPC = { host: "ext-settings" };
var RESIDENCY_IPC = { host: "ext-residency" };
var BACKEND_HOST_ENDPOINTS = Object.freeze([
  { id: "workRecords.readPage", surface: "backend", kind: "call", status: "open", permissions: ["work-records:read"], conditions: ["fullTrust"], input: WorkRecordsPageRequestSchema, output: WorkRecordsPageSchema, ipc: capabilityCall("workRecords", "readPage"), summary: "分頁讀「已結算的打卡紀錄」" },
  { id: "workRecords.subscribeSettledChanges", surface: "backend", kind: "event", status: "open", permissions: ["work-records:read"], conditions: ["fullTrust"], input: null, output: WorkRecordsSettledChangeSchema, ipc: { host: "ext-capability-event", method: `${PLUGIN_HOST_DATA_CAPABILITIES.workRecords}/settled-changed` }, onRevoke: "drop-subscription", summary: "有新結算時收通知（至少間隔 60 秒）" },
  { id: "agentDirectory.readPage", surface: "backend", kind: "call", status: "open", permissions: ["agent-directory:read"], conditions: ["fullTrust"], input: DirectoryPageRequestSchema, output: AgentDirectoryPageSchema, ipc: capabilityCall("agentDirectory", "readPage"), summary: "分頁讀代理名錄" },
  { id: "projectDirectory.readPage", surface: "backend", kind: "call", status: "open", permissions: ["project-directory:read"], conditions: ["fullTrust"], input: DirectoryPageRequestSchema, output: ProjectDirectoryPageSchema, ipc: capabilityCall("projectDirectory", "readPage"), summary: "分頁讀專案名錄" },
  { id: "pluginState.readPage", surface: "backend", kind: "call", status: "open", permissions: ["plugin-state:read"], conditions: ["fullTrust"], input: PluginStateReadPageInputSchema, output: PluginStatePageSchema, ipc: capabilityCall("pluginState", "readPage"), summary: "讀外掛存在 Core 資料庫的狀態紀錄" },
  { id: "pluginState.writeBatch", surface: "backend", kind: "call", status: "open", permissions: ["plugin-state:write"], conditions: ["fullTrust"], input: PluginStateBatchV1Schema, output: null, ipc: capabilityCall("pluginState", "writeBatch"), summary: "批次寫入；可帶 `expectedRevision` 防覆蓋" },
  { id: "pluginState.deleteBatch", surface: "backend", kind: "call", status: "open", permissions: ["plugin-state:write"], conditions: ["fullTrust"], input: PluginStateDeleteBatchV1Schema, output: null, ipc: capabilityCall("pluginState", "deleteBatch"), summary: "批次刪除" },
  { id: "settings.all", surface: "backend", kind: "call", status: "open", permissions: ["settings:plugin"], conditions: ["manifest:settingsSchema"], input: null, output: SettingsValuesSchema, ipc: SETTINGS_IPC, summary: "設定檔宣告了 `settingsSchema`；讀已驗證的全部設定值" },
  { id: "settings.get", surface: "backend", kind: "call", status: "open", permissions: ["settings:plugin"], conditions: ["manifest:settingsSchema"], input: SettingsKeySchema, output: SettingsValueSchema, ipc: SETTINGS_IPC, summary: "同上；讀單一設定值" },
  { id: "settings.onChange", surface: "backend", kind: "event", status: "open", permissions: ["settings:plugin"], conditions: ["manifest:settingsSchema"], input: null, output: SettingsValuesSchema, ipc: SETTINGS_IPC, onRevoke: "drop-subscription", summary: "同上；設定變動時收通知" },
  { id: "processHelper.openBundledHelper", surface: "backend", kind: "call", status: "open", permissions: ["process:spawn"], conditions: ["fullTrust", "manifest:processHelper"], input: ProcessHelperIdSchema, output: null, ipc: helperCall("open"), summary: "完全信任級；須設定檔 `processHelper` 宣告；啟動隨外掛附的輔助程式" },
  { id: "processHelper.write", surface: "backend", kind: "call", status: "open", permissions: ["process:spawn"], conditions: ["fullTrust"], input: ProcessHelperWriteInputSchema, output: null, ipc: helperCall("write"), summary: "完全信任級；單幀 64 KiB" },
  { id: "processHelper.read", surface: "backend", kind: "call", status: "open", permissions: ["process:spawn"], conditions: ["fullTrust"], input: ProcessHelperReadInputSchema, output: ProcessHelperReadOutputSchema, ipc: helperCall("read"), summary: "完全信任級；讀輔助程式的輸出" },
  { id: "processHelper.close", surface: "backend", kind: "call", status: "open", permissions: ["process:spawn"], conditions: ["fullTrust"], input: ProcessHelperIdSchema, output: null, ipc: helperCall("close"), summary: "完全信任級；關閉輔助程式" },
  { id: "ai.getOptions", surface: "backend", kind: "call", status: "open", permissions: ["ai:chat"], conditions: [], input: null, output: AiOptionsSchema, ipc: capabilityCall("aiChat", "getOptions"), summary: "後端沒有「畫面須看得到」的條件；不設後端專用次數上限" },
  { id: "ai.openSession", surface: "backend", kind: "call", status: "open", permissions: ["ai:chat"], conditions: [], input: BackendAiOpenSessionInputSchema, output: BackendAiOpenSessionOutputSchema, ipc: capabilityCall("aiChat", "openSession"), onRevoke: "close-session", summary: "可指定既有 Task；帶 `resume` 可重新接上既有對話" },
  { id: "ai.complete", surface: "backend", kind: "call", status: "open", permissions: ["ai:chat"], conditions: [], input: BackendAiCompleteInputSchema, output: BackendAiCompleteOutputSchema, ipc: capabilityCall("aiChat", "complete"), summary: "可指定既有 Task；等待本次 Session 回合完整結束後回傳，沿用同一 AI Chat 配額" },
  { id: "session.send", surface: "backend", kind: "session", status: "open", permissions: ["ai:chat"], conditions: [], input: BackendSessionSendInputSchema, output: SessionSendOutputSchema, ipc: capabilityCall("aiChat", "send"), summary: "送一回合文字，可附 JPEG／PNG 圖片" },
  { id: "session.onEvent", surface: "backend", kind: "session", status: "open", permissions: ["ai:chat"], conditions: [], input: null, output: SessionEventSchema, ipc: { host: "ext-capability-event", method: `${PLUGIN_HOST_DATA_CAPABILITIES.aiChat}/${PLUGIN_HOST_AI_CHAT_TURN_EVENT}` }, summary: "串流收事件" },
  { id: "session.interrupt", surface: "backend", kind: "session", status: "open", permissions: ["ai:chat"], conditions: [], input: null, output: null, ipc: capabilityCall("aiChat", "interrupt"), summary: "中斷目前回合" },
  { id: "session.close", surface: "backend", kind: "session", status: "open", permissions: ["ai:chat"], conditions: [], input: null, output: null, ipc: capabilityCall("aiChat", "close"), summary: "關閉對話；權限被撤銷時進行中的對話也會被關閉（R-HST-3）" },
  { id: "secrets.get", surface: "backend", kind: "call", status: "open", permissions: ["secrets:plugin"], conditions: [], input: SecretNameSchema, output: SecretValueSchema.nullable(), ipc: capabilityCall("secrets", "get"), summary: "只讀自己的祕密（別的外掛讀不到）" },
  { id: "secrets.set", surface: "backend", kind: "call", status: "open", permissions: ["secrets:plugin"], conditions: [], input: BackendSecretsSetInputSchema, output: null, ipc: capabilityCall("secrets", "set"), summary: "加密保存" },
  { id: "secrets.remove", surface: "backend", kind: "call", status: "open", permissions: ["secrets:plugin"], conditions: [], input: SecretNameSchema, output: null, ipc: capabilityCall("secrets", "remove"), summary: "刪除" },
  { id: "secrets.list", surface: "backend", kind: "call", status: "open", permissions: ["secrets:plugin"], conditions: [], input: null, output: SecretNamesSchema, ipc: capabilityCall("secrets", "list"), summary: "列出名稱" },
  { id: "secrets.available", surface: "backend", kind: "call", status: "open", permissions: ["secrets:plugin"], conditions: [], input: null, output: SecretsAvailableSchema, ipc: capabilityCall("secrets", "available"), summary: "查系統能不能加密保存" },
  { id: "capabilities.list", surface: "backend", kind: "call", status: "open", permissions: [], conditions: ["fullTrust"], input: null, output: LinkCapabilityEntryListSchema, ipc: capabilityCall("capabilityControl", "list"), summary: "只列自己 manifest 宣告過的類別（R-REG-5）" },
  { id: "capabilities.openLink", surface: "backend", kind: "call", status: "open", permissions: ["cap:*", "network:loopback"], conditions: ["fullTrust", { note: "scope:'use' 須使用者同意；後端沒有「畫面須看得到」的條件（R-TKT-7），可背景使用（R-CON-31）；申請高風險群組一律 not_granted（R-TKT-10）" }], input: OpenLinkCallSchema, output: LinkTicketSchema, ipc: capabilityCall("capabilityControl", "openLink"), summary: "`scope:'use'` 須使用者同意；後端沒有「畫面須看得到」的條件（R-TKT-7），可背景使用（R-CON-31）；申請高風險群組一律 `not_granted`（R-TKT-10）" },
  { id: "capabilities.onChange", surface: "backend", kind: "event", status: "open", permissions: [], conditions: ["fullTrust"], input: null, output: LinkCapabilityEventSchema, ipc: { host: "ext-capability-event", method: `${PLUGIN_HOST_DATA_CAPABILITIES.capabilityControl}/changed` }, summary: "只收自己宣告過的類別（R-REG-8）；含連線被關閉的通知" },
  { id: "residency.current", surface: "backend", kind: "call", status: "open", permissions: [], conditions: ["fullTrust"], input: null, output: PluginBackendResidencyV1Schema, ipc: RESIDENCY_IPC, summary: "讀自己目前的背景常駐等級與原因；撤銷 background:resident 後仍可讀" },
  { id: "residency.onChange", surface: "backend", kind: "event", status: "open", permissions: [], conditions: ["fullTrust"], input: null, output: PluginBackendResidencyV1Schema, ipc: RESIDENCY_IPC, summary: "常駐等級或原因改變時收通知" }
]);

var SUMMARIES = Object.freeze({
  "program.describe": "永遠可用；列出目前可用的 Program 操作",
  "conversation.dispatch": "使用者同意；在專案或任務上開對話並送第一句",
  "conversation.read": "只讀自己開的對話訊息",
  "conversation.followUp": "只對自己開的對話追問",
  "data.projects.list": "分頁列出專案（可搜尋）",
  "data.projects.get": "取單一專案",
  "data.projects.create": "建立專案",
  "data.projects.update": "修改專案；須帶 `expectedAuthoredRevision` 防覆蓋",
  "data.projects.delete": "刪除專案；須帶 `expectedAuthoredRevision`",
  "data.milestones.list": "分頁列出里程碑（可搜尋）",
  "data.milestones.get": "取單一里程碑",
  "data.milestones.create": "建立里程碑",
  "data.milestones.update": "修改里程碑；須帶 `expectedAuthoredRevision` 防覆蓋",
  "data.milestones.delete": "刪除里程碑；須帶 `expectedAuthoredRevision`",
  "data.tasks.list": "分頁列出任務（可搜尋）",
  "data.tasks.get": "取單一任務",
  "data.tasks.create": "建立任務",
  "data.tasks.update": "修改任務；須帶 `expectedAuthoredRevision` 防覆蓋",
  "data.tasks.delete": "刪除任務；須帶 `expectedAuthoredRevision`"
});
var CONDITIONS = Object.freeze({
  "conversation.dispatch": ["consent"]
});
var asPermission = (permission2) => permission2;
var permissionsOf = (operation) => Object.entries(PLUGIN_PROGRAM_PERMISSION_OPERATIONS_V1).filter(([, operations]) => operations.includes(operation)).map(([permission2]) => asPermission(permission2));
var BACKEND_PROGRAM_METHOD = `${PLUGIN_HOST_DATA_CAPABILITIES.programApi}/${PLUGIN_HOST_DATA_METHODS.programApi.call}`;
var SHARED_PROGRAM_ENDPOINTS = Object.freeze(PLUGIN_PROGRAM_OPERATION_NAMES_V1.map((operation) => ({
  id: `program.call:${operation}`,
  surface: "both",
  kind: "call",
  status: "open",
  permissions: permissionsOf(operation),
  conditions: CONDITIONS[operation] ?? [],
  ipc: { channel: PLUGIN_PROGRAM_API_CHANNELS_V1.REQUEST, op: operation, host: "capability-call", method: BACKEND_PROGRAM_METHOD },
  summary: SUMMARIES[operation]
})));

var { ASSET_PACKS, ASSET_PACK_MANAGE, STORE, STORE_ACQUIRE, AGENT_AVATAR, MODELS_ACT, MODELS_PROGRESS } = PLUGIN_CORE_CHANNELS;
var AI2 = PLUGIN_AI_CHANNELS;
var CAPABILITY = PLUGIN_CAPABILITY_CHANNELS;
var NOOP = () => void 0;
var packRead = (op) => branchOf(PluginAssetPacksRequestSchema, op);
var packManage = (op) => branchOf(PluginAssetPackManageRequestSchema, op);
var storeRead = (op) => branchOf(PluginStoreReadRequestSchema, op);
var storeAct = (op) => branchOf(PluginStoreActRequestSchema, op);
var VIEW_SERVICE_ENDPOINTS = Object.freeze([
  { id: "ai.getOptions", surface: "view", kind: "call", status: "open", permissions: ["ai:chat"], conditions: [], summary: "查可用的供應商、模型、思考強度、額度狀態", ipc: { channel: AI2.REQUEST, op: "getOptions" }, probe: [], input: AiGetOptionsInputSchema, output: AiOptionsSchema, onRevoke: "none" },
  { id: "ai.openSession", surface: "view", kind: "call", status: "open", permissions: ["ai:chat"], conditions: ["visible"], summary: "畫面須看得到；可指定既有 Task，帶 `resume` 可重新接上既有對話、取回進行中的回合", ipc: { channel: AI2.REQUEST, op: "openSession" }, probe: [{ system: "probe" }], input: AiOpenSessionInputSchema, output: AiOpenSessionOutputSchema, onRevoke: "close-session" },
  { id: "ai.complete", surface: "view", kind: "call", status: "open", permissions: ["ai:chat"], conditions: ["visible"], summary: "等待本次回合完整結束後回覆；可指定既有 Task，新 Session 會在所有結果路徑關閉", ipc: { channel: AI2.REQUEST, op: "complete" }, probe: [{ system: "probe", text: "probe" }], input: AiCompleteInputSchema, output: AiCompleteOutputSchema, onRevoke: "none" },
  { id: "session.send", surface: "view", kind: "session", status: "open", permissions: ["ai:chat"], conditions: [], summary: "送一回合文字，可附 JPEG／PNG 圖片", ipc: { channel: AI2.REQUEST, op: "send" }, probe: [{ text: "probe" }], input: SessionSendInputSchema, output: SessionSendOutputSchema, onRevoke: "none" },
  { id: "session.onEvent", surface: "view", kind: "session", status: "open", permissions: ["ai:chat"], conditions: [], summary: "串流收「開始、文字片段、完成、失敗」事件", ipc: { channel: AI2.EVENT }, probe: [NOOP], input: null, output: SessionEventSchema, onRevoke: "close-session" },
  { id: "session.interrupt", surface: "view", kind: "session", status: "open", permissions: ["ai:chat"], conditions: [], summary: "中斷目前回合", ipc: { channel: AI2.REQUEST, op: "interrupt" }, probe: [], input: SessionInterruptInputSchema, output: null, onRevoke: "none" },
  { id: "session.close", surface: "view", kind: "session", status: "open", permissions: ["ai:chat"], conditions: [], summary: "關閉對話", ipc: { channel: AI2.REQUEST, op: "close" }, probe: [], input: SessionCloseInputSchema, output: null, onRevoke: "none" },
  { id: "capability.list", surface: "view", kind: "call", status: "open", permissions: [], conditions: [], summary: "只列自己 manifest 宣告過的類別（R-REG-5）；不含端點", ipc: { channel: CAPABILITY.REQUEST, op: "list" }, probe: [], input: null, output: LinkCapabilityEntryListSchema, onRevoke: "none" },
  { id: "capability.openLink", surface: "view", kind: "call", status: "open", permissions: ["cap:*", "network:loopback"], conditions: [{ note: "scope:'use' 須使用者同意、畫面須看得到；scope:'describe' 同樣須兩個權限、免同意免可見；完整檢查順序見 §1.4.4；Core 當使用方者免（R-TKT-9）" }], summary: "`scope:'use'` 須使用者同意、畫面須看得到；`scope:'describe'` 同樣須兩個權限、免同意免可見；完整檢查順序見 §1.4.4；Core 當使用方者免（R-TKT-9）", ipc: { channel: CAPABILITY.REQUEST, op: "openLink" }, probe: ["teamuq.stt@1"], input: branchOf(CapabilityRequestSchema, "openLink"), output: LinkTicketSchema, onRevoke: "none" },
  { id: "capability.onChange", surface: "view", kind: "event", status: "open", permissions: [], conditions: [], summary: "只收自己宣告過的類別（R-REG-8）；含連線被關閉的通知", ipc: { channel: CAPABILITY.EVENT }, probe: [NOOP], input: null, output: LinkCapabilityEventSchema, onRevoke: "none" },
  { id: "assetPacks.list", surface: "view", kind: "call", status: "open", permissions: ["asset:pack"], conditions: [], summary: "列出設定檔宣告的素材包與模型包及狀態", ipc: { channel: ASSET_PACKS, op: "list" }, probe: [], input: packRead("list"), output: PluginAssetPackStateSchema.array(), onRevoke: "none" },
  { id: "assetPacks.files", surface: "view", kind: "call", status: "open", permissions: ["asset:pack"], conditions: [], summary: "列出某包內的檔案與大小", ipc: { channel: ASSET_PACKS, op: "files" }, probe: ["probe-pack"], input: packRead("files"), output: PluginAssetPackFileSchema.array(), onRevoke: "none" },
  { id: "assetPacks.import", surface: "view", kind: "call", status: "open", permissions: ["asset:pack"], conditions: ["visible"], summary: "畫面須看得到；一次一個；開 Core 的檔案選擇器", ipc: { channel: ASSET_PACK_MANAGE, op: "import" }, probe: [], input: packManage("import"), output: PluginAssetPackImportResultSchema, onRevoke: "none" },
  { id: "assetPacks.remove", surface: "view", kind: "call", status: "open", permissions: ["asset:pack"], conditions: ["visible", "consent"], summary: "畫面須看得到；Core 會再確認", ipc: { channel: ASSET_PACK_MANAGE, op: "remove" }, probe: ["probe-pack"], input: packManage("remove"), output: PluginAssetPackRemoveResultSchema, onRevoke: "none" },
  { id: "assetPacks.acquire", surface: "view", kind: "call", status: "open", permissions: ["asset:pack"], conditions: ["visible", "consent"], summary: "畫面須看得到；Core 會再確認；下載並安裝", ipc: { channel: MODELS_ACT, op: "acquire" }, probe: ["probe-pack"], input: branchOf(PluginModelsActRequestV1Schema, "acquire"), output: ModelAcquireOutcomeV1Schema, onRevoke: "none" },
  { id: "assetPacks.cancel", surface: "view", kind: "call", status: "open", permissions: ["asset:pack"], conditions: ["visible"], summary: "畫面須看得到；取消下載", ipc: { channel: MODELS_ACT, op: "cancel" }, probe: ["probe-pack"], input: branchOf(PluginModelsActRequestV1Schema, "cancel"), output: null, onRevoke: "none" },
  { id: "assetPacks.onProgress", surface: "view", kind: "event", status: "open", permissions: ["asset:pack"], conditions: [], summary: "訂閱下載進度", ipc: { channel: MODELS_PROGRESS }, probe: [NOOP], input: null, output: ModelAcquireProgressV1Schema, onRevoke: "drop-subscription" },
  { id: "store.status", surface: "view", kind: "call", status: "open", permissions: ["store:browse"], conditions: [], summary: "查商店目錄狀態（新、舊、離線、不受信任）", ipc: { channel: STORE, op: "status" }, probe: [], input: storeRead("status"), output: PluginStoreStatusViewV1Schema, onRevoke: "none" },
  { id: "store.list", surface: "view", kind: "call", status: "open", permissions: ["store:browse"], conditions: [], summary: "分頁列出商品", ipc: { channel: STORE, op: "list" }, probe: [], input: storeRead("list"), output: PluginStoreListViewV1Schema, onRevoke: "none" },
  { id: "store.get", surface: "view", kind: "call", status: "open", permissions: ["store:browse"], conditions: [], summary: "取商品詳情與預覽", ipc: { channel: STORE, op: "get" }, probe: ["probe-entry"], input: storeRead("get"), output: PluginStoreEntryDetailViewV1Schema.nullable(), onRevoke: "none" },
  { id: "store.library", surface: "view", kind: "call", status: "open", permissions: ["store:browse", "asset:pack"], conditions: [], summary: "列出已安裝的商品、未完成的下載與可更新的項目", ipc: { channel: STORE, op: "library" }, probe: [{ protocolVersion: 1, op: "library" }], input: PluginStoreAuthorLibraryRequestV1Schema, output: PluginStoreAuthorLibraryV1Schema, onRevoke: "none" },
  { id: "store.preflight", surface: "view", kind: "call", status: "open", permissions: ["store:browse", "asset:pack"], conditions: [], summary: "取得前先查所需空間", ipc: { channel: STORE, op: "preflight" }, probe: ["probe-entry"], input: storeRead("preflight"), output: PluginStorePreflightViewV1Schema, onRevoke: "none" },
  { id: "store.acquire", surface: "view", kind: "call", status: "open", permissions: ["store:browse", "asset:pack"], conditions: ["visible", "consent"], summary: "畫面須看得到；Core 確認視窗；取得（安裝或更新）", ipc: { channel: STORE_ACQUIRE, op: "acquire" }, probe: ["probe-entry"], input: storeAct("acquire"), output: PluginStoreAcquireOutcomeV1Schema, onRevoke: "none" },
  { id: "store.cancel", surface: "view", kind: "call", status: "open", permissions: ["store:browse", "asset:pack"], conditions: ["visible"], summary: "畫面須看得到；帶 `discard` 時一併丟棄未完成的下載", ipc: { channel: STORE_ACQUIRE, op: "cancel" }, probe: ["probe-entry"], input: storeAct("cancel"), output: null, onRevoke: "none" },
  { id: "store.rollback", surface: "view", kind: "call", status: "open", permissions: ["store:browse", "asset:pack"], conditions: ["visible"], summary: "畫面須看得到；回到前一版", ipc: { channel: STORE_ACQUIRE, op: "rollback" }, probe: ["probe-entry"], input: storeAct("rollback"), output: PluginStoreRollbackOutcomeV1Schema, onRevoke: "none" },
  { id: "store.onEvent", surface: "view", kind: "event", status: "open", permissions: ["store:browse", "asset:pack"], conditions: [], summary: "訂閱下載、驗證、安裝進度與商品狀態變動", ipc: { channel: PLUGIN_CORE_CHANNELS.STORE_EVENT }, probe: [NOOP], input: null, output: PluginStoreAuthorEventV1Schema, onRevoke: "drop-subscription" },
  { id: "backend.call", surface: "view", kind: "call", status: "open", permissions: [], conditions: ["fullTrust", "manifest:backendMethods"], summary: "完全信任級的組合外掛；設定檔 `backendMethods` 白名單；JSON 進 JSON 出；宿主 API，不經票與直連", ipc: { channel: PLUGIN_BACKEND_INVOKE_CHANNEL }, probe: ["probe", null], input: PluginBackendInvokeRequestV1Schema, output: fieldOf(branchOf(PluginBackendInvokeResultV1Schema, true), "value"), onRevoke: "none" },
  { id: "agentAvatar.read", surface: "view", kind: "call", status: "open", permissions: ["agent:avatar-read"], conditions: [], summary: "讀代理頭像（png、jpeg、webp 位元組）；沒有頭像回空值", ipc: { channel: AGENT_AVATAR }, probe: ["probe-agent"], input: PluginAgentAvatarRequestV1Schema, output: fieldOf(PluginAgentAvatarResultV1Schema, "image"), onRevoke: "none" }
]);

var { STORAGE, SETTINGS, SECRETS: SECRETS2 } = PLUGIN_CORE_CHANNELS;
var NOOP2 = () => void 0;
var VIEW_SHELL_ENDPOINTS = Object.freeze([
  { id: "presentation.get", surface: "view", kind: "call", status: "open", permissions: ["ui:view"], conditions: [], summary: "讀目前是分頁、全頁或設定頁、是否全螢幕、是否看得到", ipc: { channel: PLUGIN_VIEW_CHANNELS.PRESENTATION_GET }, probe: [], input: null, output: PluginViewPresentationStateSchema, onRevoke: "none" },
  { id: "presentation.request", surface: "view", kind: "call", status: "open", permissions: ["ui:view"], conditions: [], summary: "要求切換呈現方式，可要求全螢幕", ipc: { channel: PLUGIN_VIEW_CHANNELS.PRESENTATION_REQUEST }, probe: ["tab"], input: PluginViewPresentationRequestSchema, output: PluginViewPresentationResultSchema, onRevoke: "none" },
  { id: "presentation.onChange", surface: "view", kind: "event", status: "open", permissions: ["ui:view"], conditions: [], summary: "訂閱呈現方式的變動", ipc: { channel: PLUGIN_VIEW_CHANNELS.PRESENTATION_CHANGED }, probe: [NOOP2], input: null, output: PluginViewPresentationChangeSchema, onRevoke: "drop-subscription" },
  { id: "storage.read", surface: "view", kind: "call", status: "open", permissions: ["storage:plugin-data"], conditions: [], summary: "只限外掛自己的資料夾；讀位元組，可指定範圍", ipc: { channel: STORAGE, op: "read" }, probe: ["probe.bin"], input: StorageReadInputSchema, output: StorageReadOutputSchema, onRevoke: "none" },
  { id: "storage.readText", surface: "view", kind: "call", status: "open", permissions: ["storage:plugin-data"], conditions: [], summary: "讀檔並轉成文字", ipc: { channel: STORAGE, op: "read" }, probe: ["probe.txt"], input: StorageReadTextInputSchema, output: StorageReadTextOutputSchema, onRevoke: "none" },
  { id: "storage.write", surface: "view", kind: "call", status: "open", permissions: ["storage:plugin-data"], conditions: [], summary: "寫入或附加", ipc: { channel: STORAGE, op: "write" }, probe: ["probe.bin", ""], input: StorageWriteInputSchema, output: StorageWriteOutputSchema, onRevoke: "none" },
  { id: "storage.list", surface: "view", kind: "call", status: "open", permissions: ["storage:plugin-data"], conditions: [], summary: "列出資料夾內容", ipc: { channel: STORAGE, op: "list" }, probe: [], input: StorageListInputSchema, output: StorageListOutputSchema, onRevoke: "none" },
  { id: "storage.stat", surface: "view", kind: "call", status: "open", permissions: ["storage:plugin-data"], conditions: [], summary: "查檔案大小與時間", ipc: { channel: STORAGE, op: "stat" }, probe: ["probe.bin"], input: StorageStatInputSchema, output: StorageStatOutputSchema, onRevoke: "none" },
  { id: "storage.remove", surface: "view", kind: "call", status: "open", permissions: ["storage:plugin-data"], conditions: [], summary: "刪檔案或資料夾", ipc: { channel: STORAGE, op: "remove" }, probe: ["probe.bin"], input: StorageRemoveInputSchema, output: StorageRemoveOutputSchema, onRevoke: "none" },
  { id: "settings.get", surface: "view", kind: "call", status: "open", permissions: ["settings:plugin"], conditions: [], summary: "讀設定值", ipc: { channel: SETTINGS, op: "get" }, probe: ["probe"], input: SettingsGetInputSchema, output: SettingsValueSchema, onRevoke: "none" },
  { id: "settings.set", surface: "view", kind: "call", status: "open", permissions: ["settings:plugin"], conditions: [], summary: "寫設定值（會通知後端更新）", ipc: { channel: SETTINGS, op: "set" }, probe: ["probe", null], input: SettingsSetInputSchema, output: SettingsWriteOutputSchema, onRevoke: "none" },
  { id: "settings.remove", surface: "view", kind: "call", status: "open", permissions: ["settings:plugin"], conditions: [], summary: "移除設定值", ipc: { channel: SETTINGS, op: "remove" }, probe: ["probe"], input: SettingsRemoveInputSchema, output: SettingsWriteOutputSchema, onRevoke: "none" },
  { id: "settings.all", surface: "view", kind: "call", status: "open", permissions: ["settings:plugin"], conditions: [], summary: "讀全部設定", ipc: { channel: SETTINGS, op: "all" }, probe: [], input: SettingsAllInputSchema, output: SettingsValuesSchema, onRevoke: "none" },
  { id: "secrets.get", surface: "view", kind: "call", status: "open", permissions: ["secrets:plugin"], conditions: [], summary: "只讀自己的祕密", ipc: { channel: SECRETS2, op: "get" }, probe: ["probe"], input: SecretsGetInputSchema, output: SecretValueSchema.nullable(), onRevoke: "none" },
  { id: "secrets.set", surface: "view", kind: "call", status: "open", permissions: ["secrets:plugin"], conditions: [], summary: "加密保存", ipc: { channel: SECRETS2, op: "set" }, probe: ["probe", ""], input: SecretsSetInputSchema, output: SecretsWriteOutputSchema, onRevoke: "none" },
  { id: "secrets.remove", surface: "view", kind: "call", status: "open", permissions: ["secrets:plugin"], conditions: [], summary: "刪除", ipc: { channel: SECRETS2, op: "remove" }, probe: ["probe"], input: SecretsRemoveInputSchema, output: SecretsWriteOutputSchema, onRevoke: "none" },
  { id: "secrets.list", surface: "view", kind: "call", status: "open", permissions: ["secrets:plugin"], conditions: [], summary: "列出名稱", ipc: { channel: SECRETS2, op: "list" }, probe: [], input: SecretsListInputSchema, output: SecretNamesSchema, onRevoke: "none" },
  { id: "secrets.available", surface: "view", kind: "call", status: "open", permissions: ["secrets:plugin"], conditions: [], summary: "查系統能不能加密保存", ipc: { channel: SECRETS2, op: "available" }, probe: [], input: SecretsAvailableInputSchema, output: SecretsAvailableSchema, onRevoke: "none" },
  { id: "input.provide", surface: "view", kind: "call", status: "open", permissions: ["input:text"], conditions: ["visible"], summary: "畫面須看得到；登記成文字輸入目標；畫面隱藏時登記暫停、不收文字（R-HST-2）", ipc: { channel: PLUGIN_INPUT_CHANNELS.REQUEST, op: "provide" }, probe: [NOOP2], input: InputProvideInputSchema, output: InputStateOutputSchema, onRevoke: "drop-registration" },
  { id: "input.stop", surface: "view", kind: "call", status: "open", permissions: [], conditions: [], summary: "恆可呼叫、冪等；未登記時無動作（R-HST-2）", ipc: { channel: PLUGIN_INPUT_CHANNELS.REQUEST, op: "stop" }, probe: [], input: InputStopInputSchema, output: InputStateOutputSchema, onRevoke: "none" },
  { id: "input.setSpeaking", surface: "view", kind: "call", status: "open", permissions: ["input:text"], conditions: [], summary: "須為目前登記的輸入目標，否則無動作；告知 Core 正在朗讀，讓語音輸入暫避（R-HST-2）", ipc: { channel: PLUGIN_INPUT_CHANNELS.REQUEST, op: "setSpeaking" }, probe: [false], input: InputSetSpeakingInputSchema, output: InputStateOutputSchema, onRevoke: "none" },
  { id: "input.state", surface: "view", kind: "call", status: "open", permissions: ["input:text"], conditions: [], summary: "只回自己的狀態（是否已登記、是否為目前輸入目標），不回其他外掛或語音輸入的狀態（R-HST-2）", ipc: { channel: PLUGIN_INPUT_CHANNELS.REQUEST, op: "state" }, probe: [], input: InputStateInputSchema, output: InputStateOutputSchema, onRevoke: "none" }
]);

var PLUGIN_ENDPOINT_COUNTS = Object.freeze({ view: 50, backend: 31, both: 19, total: 100 });
var PLUGIN_ENDPOINTS = Object.freeze([...VIEW_SHELL_ENDPOINTS, ...VIEW_SERVICE_ENDPOINTS, ...BACKEND_HOST_ENDPOINTS, ...SHARED_PROGRAM_ENDPOINTS]);

var keyOf = (surface, id7) => `${surface} ${id7}`;
function createRouter(now2) {
  const entries = /* @__PURE__ */ new Map();
  const log = [];
  const entryOf2 = (surface, id7) => {
    const entry2 = entries.get(keyOf(surface, id7));
    if (entry2 === void 0) throw new TestHostNotModeled(surface, id7);
    return entry2;
  };
  const record = (surface, id7, args, reply, injected) => {
    log.push({ seq: log.length + 1, at: now2(), surface, id: id7, args, reply, injected });
    return reply;
  };
  return {
    register: (surface, id7, errorCodes, handle) => {
      const cataloged = PLUGIN_ENDPOINTS.some((endpoint2) => endpoint2.id === id7 && (endpoint2.surface === surface || endpoint2.surface === "both"));
      if (!cataloged) throw new TestHostInvalid("register", [`${surface} ${id7} is not in the endpoint catalog`]);
      if (entries.has(keyOf(surface, id7))) throw new TestHostInvalid("register", [`${surface} ${id7} is already registered`]);
      entries.set(keyOf(surface, id7), { surface, id: id7, errorCodes: [...errorCodes], handle, injections: [] });
    },
    modeled: () => [...entries.values()].map((entry2) => ({ surface: entry2.surface, id: entry2.id })),
    inject: (surface, id7, code2, times = 1) => {
      const entry2 = entryOf2(surface, id7);
      if (!entry2.errorCodes.includes(code2)) throw new TestHostInvalid("inject", [`${code2} is not in the error list of ${surface} ${id7}`]);
      if (!Number.isInteger(times) || times < 1) throw new TestHostInvalid("inject", ["times must be a positive integer"]);
      entry2.injections.push({ code: code2, remaining: times });
    },
    dispatch: async (surface, id7, args) => {
      const entry2 = entryOf2(surface, id7);
      const injection = entry2.injections.find((item) => item.remaining > 0);
      if (injection !== void 0) {
        injection.remaining -= 1;
        return record(surface, id7, args, { ok: false, error: injection.code }, true);
      }
      const reply = await entry2.handle(args);
      return record(surface, id7, args, reply, false);
    },
    reject: (surface, id7, args, reply) => record(surface, id7, args, reply, false),
    calls: (filter) => log.filter((call) => filter === void 0 || call.id === filter || `${call.surface}:${call.id}` === filter)
  };
}

var CoreFailure = class extends Error {
  code;
  constructor(code2) {
    super(code2);
    this.name = "CoreFailure";
    this.code = code2;
  }
};
var ok3 = (value) => ({ ok: true, value });
var fail2 = (error) => ({ ok: false, error });
function accessDenialOf(enabled, grants, permission2) {
  if (!enabled) return "plugin_not_active";
  return grants.has(permission2) ? null : "plugin_permission_denied";
}
function byteLengthOf(value) {
  try {
    const encoded = JSON.stringify(value);
    return encoded === void 0 ? null : new TextEncoder().encode(encoded).byteLength;
  } catch {
    return null;
  }
}

var PLUGIN_STATE_ERRORS = ["plugin_permission_denied", "plugin_host_request_too_large", PLUGIN_STATE_RETIRED_ERROR_CODE];
function createBackendRules(deps) {
  const handlers = /* @__PURE__ */ new Map();
  const inFlight = /* @__PURE__ */ new Set();
  let fenced = false;
  const timeoutPlugin = () => {
    fenced = true;
    for (const cancel of [...inFlight]) cancel("backend_invoke_timeout");
  };
  const settle = (params, handler) => new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (envelope3) => {
      if (settled) return;
      settled = true;
      timer?.cancel();
      inFlight.delete(cancel);
      resolve(envelope3);
    };
    const cancel = (code2) => finish(fail2(code2));
    inFlight.add(cancel);
    timer = deps.clock.later(timeoutPlugin, PLUGIN_BACKEND_INVOKE_LIMITS.timeoutMs);
    Promise.resolve().then(() => handler(params)).then((value) => {
      const bytes4 = pluginBackendInvokePayloadBytes({ ok: true, value });
      if (bytes4 === null) return finish(fail2("backend_invoke_invalid"));
      if (bytes4 > PLUGIN_BACKEND_INVOKE_LIMITS.payloadBytes) return finish(fail2("backend_invoke_too_large"));
      finish(ok3(value));
    }, () => finish(fail2("plugin_backend_unavailable")));
  });
  const invoke = {
    surface: "view",
    id: "backend.call",
    errorCodes: [...PLUGIN_BACKEND_INVOKE_ERROR_CODES],
    handle: async (args) => {
      const bytes4 = pluginBackendInvokePayloadBytes(args);
      const parsed = PluginBackendInvokeRequestV1Schema.safeParse(args);
      if (!parsed.success || bytes4 === null) return fail2("backend_invoke_invalid");
      if (bytes4 > PLUGIN_BACKEND_INVOKE_LIMITS.payloadBytes) return fail2("backend_invoke_too_large");
      if (fenced) return fail2("plugin_disabled");
      if (inFlight.size >= PLUGIN_BACKEND_INVOKE_LIMITS.inFlight) return fail2("plugin_backend_unavailable");
      if (!deps.enabled()) return fail2("plugin_disabled");
      if (deps.trustTier !== "full-trust") return fail2("plugin_permission_denied");
      const { method: method2, params } = parsed.data;
      if (!deps.backendMethods.includes(method2)) return fail2("backend_method_not_allowed");
      const handler = handlers.get(method2);
      if (handler === void 0) throw new TestHostInvalid("backend.call", [`no backend handler is registered for manifest method ${method2}`]);
      return settle(params, handler);
    }
  };
  const pluginState = (id7, permission2) => ({
    surface: "backend",
    id: id7,
    errorCodes: PLUGIN_STATE_ERRORS,
    handle: async (args) => {
      if (!deps.enabled()) throw new TestHostRefused(`${id7} is not dispatched while the plugin is disabled`);
      if (!deps.grants.has(permission2)) return fail2("plugin_permission_denied");
      if ((byteLengthOf(args) ?? Infinity) > PLUGIN_HOST_DATA_LIMITS.payloadBytes) return fail2("plugin_host_request_too_large");
      if (deps.stateAuthority === "core") return fail2(PLUGIN_STATE_RETIRED_ERROR_CODE);
      throw new TestHostNotModeled("backend", id7, "the sqlite plugin-state store semantics (revision checks, unchanged counts, cursors) are not verified");
    }
  });
  return {
    endpoints: [
      invoke,
      pluginState("pluginState.readPage", PLUGIN_HOST_DATA_PERMISSIONS.pluginStateRead),
      pluginState("pluginState.writeBatch", PLUGIN_HOST_DATA_PERMISSIONS.pluginStateWrite),
      pluginState("pluginState.deleteBatch", PLUGIN_HOST_DATA_PERMISSIONS.pluginStateWrite)
    ],
    setHandler: (method2, handle) => {
      if (!deps.backendMethods.includes(method2)) throw new TestHostInvalid("setBackendHandler", [`${method2} is not listed in the manifest backendMethods`]);
      handlers.set(method2, handle);
    },
    revoke: () => {
      fenced = true;
      for (const cancel of [...inFlight]) cancel("plugin_permission_denied");
    },
    activate: () => {
      fenced = false;
    }
  };
}

function createSettingsStore() {
  let values = {};
  return {
    all: () => ({ ...values }),
    get: (key4) => Object.prototype.hasOwnProperty.call(values, key4) ? values[key4] ?? null : null,
    set: (key4, value) => {
      let encoded;
      try {
        encoded = JSON.stringify(value);
      } catch {
        throw new CoreFailure("plugin_request_invalid");
      }
      if (encoded === void 0) throw new CoreFailure("plugin_request_invalid");
      const next = { ...values, [key4]: JSON.parse(encoded) };
      if (Object.keys(next).length > PLUGIN_CORE_LIMITS.settingsKeys || (byteLengthOf(next) ?? Infinity) > PLUGIN_CORE_LIMITS.settingsBytes) throw new CoreFailure("settings_too_large");
      values = next;
    },
    remove: (key4) => {
      const next = { ...values };
      delete next[key4];
      values = next;
    }
  };
}
var VIEW_ERRORS = ["plugin_permission_denied", "plugin_not_active", "plugin_request_invalid", "settings_too_large", "settings_failed"];
var BACKEND_ERRORS = ["plugin_permission_denied"];
function createSettingsRules(deps) {
  const listeners = /* @__PURE__ */ new Map();
  let subscriptionSequence = 0;
  const declaredAndGranted = () => deps.schema !== void 0 && deps.grants.has(PLUGIN_CORE_PERMISSIONS.SETTINGS);
  const effective2 = () => {
    if (deps.schema === void 0) throw new TestHostRefused("backend settings are only defined when the manifest declares settingsSchema");
    return effectiveSettingValues(deps.schema, deps.store.all());
  };
  const notifyChanged = () => {
    if (!deps.enabled() || !declaredAndGranted()) return;
    const values = effective2();
    for (const subscription of listeners.keys()) deps.emit({ surface: "backend", id: "settings.onChange", value: { subscription, values } });
  };
  const viewEndpoint = (id7, op, run) => ({
    surface: "view",
    id: id7,
    errorCodes: VIEW_ERRORS,
    handle: async (args) => {
      const denial = accessDenialOf(deps.enabled(), deps.grants, PLUGIN_CORE_PERMISSIONS.SETTINGS);
      if (denial !== null) return fail2(denial);
      const parsed = PluginSettingsRequestSchema.safeParse(args);
      if (!parsed.success || parsed.data.op !== op) return fail2("plugin_request_invalid");
      try {
        return ok3(run(parsed.data));
      } catch (error) {
        if (error instanceof CoreFailure) return fail2(error.code);
        throw error;
      }
    }
  });
  const backendEndpoint = (id7, errorCodes, run) => ({
    surface: "backend",
    id: id7,
    errorCodes,
    handle: async (args) => {
      if (!declaredAndGranted()) return fail2("plugin_permission_denied");
      if (!deps.enabled()) throw new TestHostRefused(`${id7} is not dispatched while the plugin is disabled`);
      return ok3(run(args));
    }
  });
  const endpoints = [
    viewEndpoint("settings.get", "get", (request) => deps.store.get(request.key)),
    viewEndpoint("settings.set", "set", (request) => {
      deps.store.set(request.key, request.value);
      notifyChanged();
      return true;
    }),
    viewEndpoint("settings.remove", "remove", (request) => {
      deps.store.remove(request.key);
      notifyChanged();
      return true;
    }),
    viewEndpoint("settings.all", "all", () => deps.store.all()),
    backendEndpoint("settings.all", BACKEND_ERRORS, () => effective2()),
    backendEndpoint("settings.get", BACKEND_ERRORS, (args) => {
      if (typeof args !== "object" || args === null || typeof args.key !== "string") throw new TestHostInvalid("backend settings.get", ["args must be { key: string }"]);
      const key4 = args.key;
      const values = effective2();
      return Object.prototype.hasOwnProperty.call(values, key4) ? values[key4] : void 0;
    }),
    backendEndpoint("settings.onChange", BACKEND_ERRORS, () => {
      subscriptionSequence += 1;
      listeners.set(subscriptionSequence, true);
      return subscriptionSequence;
    })
  ];
  return {
    endpoints,
    onRevoked: (permission2) => {
      if (permission2 === PLUGIN_CORE_PERMISSIONS.SETTINGS) listeners.clear();
    }
  };
}

var RESERVED_DEVICE_NAMES = /* @__PURE__ */ new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  ...Array.from({ length: 10 }, (_, index) => `COM${index}`),
  ...Array.from({ length: 10 }, (_, index) => `LPT${index}`),
  "COM¹",
  "COM²",
  "COM³",
  "LPT¹",
  "LPT²",
  "LPT³"
]);
var MAX_ENTRY_PATH_LENGTH = 200;
var MAX_SEGMENT_LENGTH = 100;
var NATIVE_LIBRARY_EXTENSIONS = /* @__PURE__ */ new Set([".node", ".dll", ".dylib", ".so"]);
var SCRIPT_OR_EXECUTABLE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".exe",
  ".sh",
  ".bat",
  ".cmd",
  ".ps1",
  ".vbs",
  ".msi",
  ".jar",
  ".lnk",
  ".scr",
  ".com",
  ".pif",
  ".reg",
  ".hta",
  ".wsf"
]);
var ACTIVE_CONTENT_EXTENSIONS = /* @__PURE__ */ new Set([".js", ".mjs", ".cjs", ".html", ".htm", ".xhtml", ".xht", ".svg", ".wasm"]);
var invalidPath = () => new CoreFailure("storage_path_invalid");
function auditName(name) {
  if (name.length === 0) throw invalidPath();
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(name)) throw invalidPath();
  if (name.length > MAX_ENTRY_PATH_LENGTH) throw invalidPath();
  if (name.includes("\\")) throw invalidPath();
  if (name.startsWith("/")) throw invalidPath();
  if (/^[A-Za-z]:/.test(name)) throw invalidPath();
  if (name.includes(":")) throw invalidPath();
  if (/[<>"|?*]/.test(name)) throw invalidPath();
  for (const segment of name.split("/")) {
    if (segment.length === 0) throw invalidPath();
    if (segment === "." || segment === "..") throw invalidPath();
    if (segment.length > MAX_SEGMENT_LENGTH) throw invalidPath();
    if (segment.endsWith(".") || segment.endsWith(" ")) throw invalidPath();
    const stem = segment.split(".")[0].trimEnd().toUpperCase();
    if (RESERVED_DEVICE_NAMES.has(stem)) throw invalidPath();
  }
}
function segmentsOf(relative, allowEmpty) {
  if (relative === "") {
    if (allowEmpty) return [];
    throw invalidPath();
  }
  if (relative.endsWith("/")) throw invalidPath();
  auditName(relative);
  const segments = relative.split("/");
  if (segments.some((segment) => segment.startsWith("."))) throw invalidPath();
  return segments;
}
function baseNameOf(name) {
  return name.slice(name.lastIndexOf("/") + 1).toLowerCase();
}
function hasNativeOrScriptExtension(name) {
  const base = baseNameOf(name);
  if (/\.so(?:\.[0-9]+)+$/.test(base)) return true;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  const extension = base.slice(dot);
  return NATIVE_LIBRARY_EXTENSIONS.has(extension) || SCRIPT_OR_EXECUTABLE_EXTENSIONS.has(extension);
}
function hasActiveContentExtension(name) {
  const base = baseNameOf(name);
  const dot = base.lastIndexOf(".");
  return dot >= 0 && ACTIVE_CONTENT_EXTENSIONS.has(base.slice(dot));
}
var keyOf2 = (segments) => segments.join("/");
function createStorageRules(deps) {
  const entries = /* @__PURE__ */ new Map();
  const lookup = (segments) => {
    for (let index = 0; index < segments.length; index += 1) {
      const entry2 = entries.get(keyOf2(segments.slice(0, index + 1)));
      if (entry2 === void 0) return null;
      if (index < segments.length - 1) {
        if (entry2.kind !== "directory") throw invalidPath();
      } else {
        return entry2;
      }
    }
    return null;
  };
  const ensureParents = (segments) => {
    for (let index = 0; index < segments.length - 1; index += 1) {
      const key4 = keyOf2(segments.slice(0, index + 1));
      const entry2 = entries.get(key4);
      if (entry2 === void 0) entries.set(key4, { kind: "directory", modifiedMs: deps.now() });
      else if (entry2.kind !== "directory") throw invalidPath();
    }
  };
  const childrenOf = (segments) => {
    const prefix = segments.length === 0 ? "" : `${keyOf2(segments)}/`;
    const children = [];
    for (const [key4, entry2] of entries) {
      if (!key4.startsWith(prefix) || key4.length === prefix.length) continue;
      const rest = key4.slice(prefix.length);
      if (!rest.includes("/")) children.push({ name: rest, entry: entry2 });
    }
    return children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  };
  const sizeOf = (entry2) => entry2.kind === "file" ? entry2.bytes.byteLength : 0;
  const readOp = (request) => {
    const entry2 = lookup(segmentsOf(request.path, false));
    if (entry2 === null) throw new CoreFailure("storage_not_found");
    if (entry2.kind !== "file") throw new CoreFailure("storage_not_a_file");
    const size2 = entry2.bytes.byteLength;
    const offset = request.offset ?? 0;
    const length = request.length ?? Math.max(0, size2 - offset);
    if (length > PLUGIN_CORE_LIMITS.chunkBytes) throw new CoreFailure("storage_too_large");
    const take = Math.max(0, Math.min(length, size2 - offset));
    return entry2.bytes.slice(offset, offset + take);
  };
  const writeOp = (request) => {
    const segments = segmentsOf(request.path, false);
    if (hasNativeOrScriptExtension(request.path) || hasActiveContentExtension(request.path)) throw invalidPath();
    if (request.data.byteLength > PLUGIN_CORE_LIMITS.chunkBytes) throw new CoreFailure("storage_too_large");
    ensureParents(segments);
    const key4 = keyOf2(segments);
    const existing = entries.get(key4);
    if (existing !== void 0 && existing.kind !== "file") throw new CoreFailure("storage_not_a_file");
    const previous = existing?.kind === "file" ? existing.bytes : new Uint8Array(0);
    if (request.append === true && previous.byteLength + request.data.byteLength > PLUGIN_CORE_LIMITS.fileBytes) throw new CoreFailure("storage_too_large");
    const next = request.append === true ? new Uint8Array([...previous, ...request.data]) : new Uint8Array(request.data);
    entries.set(key4, { kind: "file", bytes: next, modifiedMs: deps.now() });
    return { size: next.byteLength };
  };
  const listOp = (request) => {
    const segments = segmentsOf(request.path ?? "", true);
    if (segments.length > 0) {
      const entry2 = lookup(segments);
      if (entry2 === null) return [];
      if (entry2.kind !== "directory") throw new CoreFailure("storage_not_a_file");
    }
    const children = childrenOf(segments);
    if (children.length > PLUGIN_CORE_LIMITS.listEntries) throw new CoreFailure("storage_too_large");
    return children.map(({ name, entry: entry2 }) => ({ name, kind: entry2.kind === "file" ? "file" : "directory", size: sizeOf(entry2) }));
  };
  const statOp = (request) => {
    const entry2 = lookup(segmentsOf(request.path, false));
    if (entry2 === null) return null;
    return { kind: entry2.kind, size: sizeOf(entry2), modifiedMs: entry2.modifiedMs };
  };
  const removeOp = (request) => {
    const segments = segmentsOf(request.path, false);
    const entry2 = lookup(segments);
    if (entry2 === null) return { removed: false };
    if (entry2.kind === "directory" && request.recursive !== true) throw new CoreFailure("storage_not_a_file");
    const key4 = keyOf2(segments);
    for (const candidate of [...entries.keys()]) {
      if (candidate === key4 || candidate.startsWith(`${key4}/`)) entries.delete(candidate);
    }
    return { removed: true };
  };
  const STORAGE_ERRORS = [
    "plugin_permission_denied",
    "plugin_not_active",
    "plugin_request_invalid",
    "storage_path_invalid",
    "storage_path_escapes",
    "storage_not_found",
    "storage_not_a_file",
    "storage_too_large",
    "storage_failed"
  ];
  const endpoint2 = (id7, op, run) => ({
    surface: "view",
    id: id7,
    errorCodes: STORAGE_ERRORS,
    handle: async (args) => {
      const denial = accessDenialOf(deps.enabled(), deps.grants, PLUGIN_CORE_PERMISSIONS.STORAGE);
      if (denial !== null) return fail2(denial);
      const parsed = PluginStorageRequestSchema.safeParse(args);
      if (!parsed.success || parsed.data.op !== op) return fail2("plugin_request_invalid");
      try {
        return ok3(run(parsed.data));
      } catch (error) {
        if (error instanceof CoreFailure) return fail2(error.code);
        throw error;
      }
    }
  });
  return [
    endpoint2("storage.read", "read", readOp),
    endpoint2("storage.readText", "read", readOp),
    endpoint2("storage.write", "write", writeOp),
    endpoint2("storage.list", "list", listOp),
    endpoint2("storage.stat", "stat", statOp),
    endpoint2("storage.remove", "remove", removeOp)
  ];
}

var SUMMARIES2 = Object.freeze({
  "program.describe": "列出此呼叫者可用的 Program API v1 操作。",
  "data.projects.list": "分頁讀取專案中繼資料。",
  "data.projects.get": "讀取一筆專案中繼資料。",
  "data.projects.create": "建立專案中繼資料。",
  "data.projects.delete": "封存專案中繼資料。",
  "data.tasks.list": "分頁讀取任務中繼資料。",
  "data.tasks.get": "讀取一筆任務中繼資料。",
  "data.tasks.create": "建立任務中繼資料。",
  "data.tasks.delete": "依產品既有語義 tombstone 任務。",
  "conversation.dispatch": "在指定專案或任務啟動對話並投遞首句。",
  "conversation.read": "讀取此呼叫者擁有的對話訊息。",
  "conversation.followUp": "向此呼叫者擁有的即時對話送出追問。",
  "data.projects.update": "以 authored revision 更新專案中繼資料。",
  "data.milestones.list": "分頁讀取里程碑中繼資料。",
  "data.milestones.get": "讀取一筆里程碑中繼資料。",
  "data.milestones.create": "建立里程碑中繼資料。",
  "data.milestones.update": "以 authored revision 更新里程碑中繼資料。",
  "data.milestones.delete": "封存里程碑中繼資料。",
  "data.tasks.update": "以 authored revision 更新任務中繼資料。"
});
var TASK_STATUS_ON_CREATE = "WAITING";
var TASK_STATUS_ON_TOMBSTONE = "archived";
var DEFAULT_PAGE_LIMIT = 50;
var CURSOR_PATTERN = /^(0|[1-9][0-9]*)$/;
var DATA_OPERATIONS = ["data.projects.list", "data.projects.get", "data.projects.create", "data.projects.delete", "data.tasks.list", "data.tasks.get", "data.tasks.create", "data.tasks.delete"];
var MODELED_OPERATIONS = ["program.describe", ...DATA_OPERATIONS];
var BACKEND_ERROR_CODES = ["plugin_host_request_invalid", "plugin_host_request_too_large"];
var PROGRAM_INVALID_REPLY = { apiVersion: 1, requestId: null, operation: null, ok: false, error: { code: "invalid_request", message: "The Program request is invalid." } };
function programOperationsOf(grants) {
  const operations = /* @__PURE__ */ new Set(["program.describe"]);
  for (const permission2 of Object.keys(PLUGIN_PROGRAM_PERMISSION_SCOPES_V1)) {
    if (!grants.has(permission2)) continue;
    for (const operation of PLUGIN_PROGRAM_PERMISSION_OPERATIONS_V1[permission2]) operations.add(operation);
  }
  return [...operations];
}
function requiredScopeOf(operation) {
  for (const permission2 of Object.keys(PLUGIN_PROGRAM_PERMISSION_SCOPES_V1)) {
    if (PLUGIN_PROGRAM_PERMISSION_OPERATIONS_V1[permission2].includes(operation)) return PLUGIN_PROGRAM_PERMISSION_SCOPES_V1[permission2];
  }
  return "none";
}
var issuesOf = (issues) => issues.map((issue) => `${issue.path.map(String).join(".") || "(reply)"}: ${issue.message}`);
function createProgramRules(deps) {
  const projects = /* @__PURE__ */ new Map();
  const tasks = /* @__PURE__ */ new Map();
  let sequence = 0;
  let generation3 = 0;
  const nextId = () => {
    sequence += 1;
    return String(sequence);
  };
  const projectDto = (row) => ({ id: row.id, name: row.name, description: row.description, authoredRevision: row.authoredRevision, archived: row.archived, readOnly: row.readOnly });
  const taskDto = (row) => ({ id: row.id, name: row.name, description: row.description, projectId: row.projectId, milestoneId: row.milestoneId, status: row.status, authoredRevision: row.authoredRevision, deletedAt: row.deletedAt, readOnly: row.readOnly });
  const gap = (surface, operation, reason3) => new TestHostNotModeled(surface, `program.call:${operation}`, reason3);
  const liveProject = (surface, operation, projectId) => {
    const row = projects.get(projectId);
    if (row === void 0 || row.archived) throw gap(surface, operation, "a missing or archived project: the Core not_found code is not verified (design D7)");
    return row;
  };
  const liveTask = (surface, operation, taskId) => {
    const row = tasks.get(taskId);
    if (row === void 0 || row.deletedAt !== null) throw gap(surface, operation, "a missing or tombstoned task: the Core not_found code is not verified (design D7)");
    return row;
  };
  const checkRevision = (row, expected) => {
    if (expected !== row.authoredRevision) throw new TestHostRefused(`expectedAuthoredRevision ${expected} does not match ${row.authoredRevision}: the Core conflict code is not verified (design D7)`);
  };
  const pageOf = (surface, operation, rows2, input, map) => {
    if (input.search !== void 0 && input.search !== null) throw gap(surface, operation, "search matching is not verified");
    if (input.snapshotGeneration !== void 0) throw gap(surface, operation, "snapshotGeneration is not verified: the Core stale-snapshot result is not modeled");
    const cursor4 = input.cursor ?? null;
    if (cursor4 !== null && !CURSOR_PATTERN.test(cursor4)) throw gap(surface, operation, "the cursor was not issued by this test host and the Core cursor format is opaque");
    const offset = cursor4 === null ? 0 : Number(cursor4);
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const items = rows2.slice(offset, offset + limit).map(map);
    return { items, nextCursor: offset + limit < rows2.length ? String(offset + limit) : null, snapshotGeneration: generation3 };
  };
  const describeRows = (allowed, catalog) => catalog.map((operation) => ({
    operation,
    requiredScope: requiredScopeOf(operation),
    available: allowed.includes(operation),
    summary: SUMMARIES2[operation]
  }));
  const execute = (surface, operation, raw, allowed) => {
    switch (operation) {
      case "program.describe":
        return { apiVersion: 1, operations: describeRows(allowed, PLUGIN_PROGRAM_OPERATION_NAMES_V1) };
      case "data.projects.list": {
        if ([...projects.values()].some((row) => row.archived)) throw gap(surface, operation, "archived projects in list results are not verified");
        return pageOf(surface, operation, [...projects.values()], raw, projectDto);
      }
      case "data.projects.get":
        return projectDto(liveProject(surface, operation, raw.projectId));
      case "data.projects.create": {
        const body = raw;
        const row = { id: nextId(), name: body.name, description: body.description ?? null, authoredRevision: 0, archived: false, readOnly: null };
        projects.set(row.id, row);
        generation3 += 1;
        return projectDto(row);
      }
      case "data.projects.delete": {
        const body = raw;
        const row = liveProject(surface, operation, body.projectId);
        checkRevision(row, body.expectedAuthoredRevision);
        if ([...tasks.values()].some((task2) => task2.projectId === row.id && task2.deletedAt === null)) throw gap(surface, operation, "archiving a project that still has tasks: the cascade is not verified");
        row.archived = true;
        row.authoredRevision += 1;
        generation3 += 1;
        return projectDto(row);
      }
      case "data.tasks.list": {
        const input = raw;
        if ([...tasks.values()].some((row) => row.deletedAt !== null)) throw gap(surface, operation, "tombstoned tasks in list results are not verified");
        if (input.projectId === null) throw gap(surface, operation, "a null projectId filter is not verified");
        const filter = input.projectId;
        const rows2 = [...tasks.values()].filter((row) => filter === void 0 || row.projectId === filter);
        return pageOf(surface, operation, rows2, input, taskDto);
      }
      case "data.tasks.get":
        return taskDto(liveTask(surface, operation, raw.taskId));
      case "data.tasks.create": {
        const body = raw;
        if (body.projectId === null) throw gap(surface, operation, "a task without a project: the Core behavior is not verified (design D7)");
        if (body.milestoneId !== void 0 && body.milestoneId !== null) throw gap(surface, operation, "milestones are outside the v1 scope");
        liveProject(surface, operation, body.projectId);
        const row = { id: nextId(), name: body.name, description: body.description ?? null, projectId: body.projectId, milestoneId: null, status: TASK_STATUS_ON_CREATE, authoredRevision: 0, deletedAt: null, readOnly: null };
        tasks.set(row.id, row);
        deps.tasks.add(row.id);
        generation3 += 1;
        return taskDto(row);
      }
      case "data.tasks.delete": {
        const body = raw;
        const row = liveTask(surface, operation, body.taskId);
        checkRevision(row, body.expectedAuthoredRevision);
        row.deletedAt = deps.now();
        row.status = TASK_STATUS_ON_TOMBSTONE;
        row.authoredRevision += 1;
        deps.tasks.remove(row.id);
        generation3 += 1;
        return taskDto(row);
      }
    }
  };
  const replyError = (request, code2, message) => ({
    apiVersion: 1,
    requestId: request.requestId,
    operation: request.operation,
    ok: false,
    error: { code: code2, message }
  });
  const checkedEnvelope = (validator, reply, operation) => {
    const checked = validator.reply.safeParse(reply);
    if (!checked.success) throw new TestHostInvalid("program reply", issuesOf(checked.error.issues));
    const body = reply;
    if (body.ok) {
      const resultSchema = validator.resultByOperation[operation];
      if (resultSchema === void 0) throw new TestHostRefused(`the injected programReplyValidator has no result schema for ${operation}`);
      const checkedResult = resultSchema.safeParse(body.result);
      if (!checkedResult.success) throw new TestHostInvalid(`program result ${operation}`, issuesOf(checkedResult.error.issues));
    }
    return ok3(reply);
  };
  const endpoint2 = (surface, operation) => ({
    surface,
    id: `program.call:${operation}`,
    errorCodes: surface === "backend" ? BACKEND_ERROR_CODES : [],
    handle: async (args) => {
      const validator = deps.validator;
      if (validator === void 0) throw new TestHostRefused(`program.call:${operation} needs the shared Program API schemas: pass programReplyValidator to createTestHostCore. The call is refused, not answered without reply validation.`);
      const bytes4 = byteLengthOf(args);
      if (surface === "backend" && bytes4 !== null && bytes4 > PLUGIN_HOST_DATA_LIMITS.payloadBytes) return fail2("plugin_host_request_too_large");
      const parsed = validator.call.safeParse(args);
      const oversized = bytes4 === null || bytes4 > validator.requestMaxBytes;
      if (!parsed.success || oversized) {
        if (surface === "backend") return fail2("plugin_host_request_invalid");
        return checkedEnvelope(validator, PROGRAM_INVALID_REPLY, "program.call");
      }
      const request = parsed.data;
      if (request.operation !== operation) throw new TestHostInvalid("program.call", [`request operation ${request.operation} does not match program.call:${operation}`]);
      if (!deps.enabled()) return checkedEnvelope(validator, replyError(request, "unauthenticated", "The Plugin is not active."), operation);
      const allowed = programOperationsOf(deps.grants);
      if (!allowed.includes(operation)) return checkedEnvelope(validator, replyError(request, "forbidden", "The Program operation is not granted."), operation);
      const result = execute(surface, operation, request.input, allowed);
      return checkedEnvelope(validator, { apiVersion: 1, requestId: request.requestId, operation, ok: true, result }, operation);
    }
  });
  const endpoints = [];
  for (const operation of MODELED_OPERATIONS) {
    endpoints.push(endpoint2("view", operation));
    endpoints.push(endpoint2("backend", operation));
  }
  return endpoints;
}

var SURFACES = ["view", "backend"];
function createTestHostCore(options) {
  const manifest = loadTestManifest(options.manifest);
  const clock = options.clock ?? createManualClock();
  const grantTable = createGrantTable(manifest.permissions, options.grants ?? manifest.permissions);
  const limits = { ...AI_CHAT_LIMITS, ...options.limits ?? {} };
  const tasks = options.tasks ?? createTaskDirectory();
  const router = createRouter(() => clock.now());
  const deliveries = [];
  let enabled = true;
  let visible = options.visible ?? true;
  let inputSequence = 0;
  let lastInput = null;
  const authorize = () => {
    if (!enabled) return "plugin_not_active";
    return grantTable.has(AI_CHAT_PERMISSION) ? null : "not_granted";
  };
  const rules = createAiRules({
    clock,
    limits,
    provider: options.provider ?? DEFAULT_AI_PROVIDER,
    tasks,
    authorize,
    visible: () => visible,
    lastInput: () => lastInput,
    deliver: (surface, sessionId5, turnId3, event) => {
      deliveries.push({ surface, sessionId: sessionId5, turnId: turnId3, event });
    }
  });
  for (const surface of SURFACES) {
    for (const endpoint2 of rules.endpoints) {
      router.register(surface, endpoint2.id, endpoint2.errorCodes, (args) => endpoint2.handle(surface, args));
    }
  }
  const events = [];
  const emit = (event) => {
    events.push({ ...event, at: clock.now() });
  };
  const settings = createSettingsRules({ enabled: () => enabled, grants: grantTable, schema: manifest.settingsSchema, store: createSettingsStore(), emit });
  const backend = createBackendRules({
    enabled: () => enabled,
    grants: grantTable,
    trustTier: manifest.trustTier,
    backendMethods: manifest.backendMethods ?? [],
    stateAuthority: options.pluginStateAuthority ?? "core",
    clock
  });
  const extra = [
    ...createStorageRules({ enabled: () => enabled, grants: grantTable, now: () => clock.now() }),
    ...settings.endpoints,
    ...backend.endpoints,
    ...createProgramRules({ enabled: () => enabled, grants: grantTable, now: () => clock.now(), tasks, validator: options.programReplyValidator })
  ];
  for (const endpoint2 of extra) {
    router.register(endpoint2.surface, endpoint2.id, endpoint2.errorCodes, (args) => endpoint2.handle(args));
  }
  const recheck = () => {
    rules.recheck();
  };
  const revokeHooks = /* @__PURE__ */ new Map();
  return {
    manifest,
    clock,
    tasks,
    limits,
    ai: rules.controls,
    register: (surface, id7, errorCodes, handle) => {
      router.register(surface, id7, errorCodes, handle);
    },
    dispatch: (surface, id7, args) => router.dispatch(surface, id7, args),
    reject: (surface, id7, args, reply) => router.reject(surface, id7, args, reply),
    inject: (surface, id7, code2, times) => {
      router.inject(surface, id7, code2, times);
    },
    calls: (filter) => router.calls(filter),
    modeled: () => router.modeled(),
    grant: (permission2) => {
      grantTable.grant(permission2);
    },
    revoke: (permission2) => {
      if (!grantTable.revoke(permission2)) return;
      settings.onRevoked(permission2);
      for (const run of revokeHooks.get(permission2) ?? []) run();
      recheck();
    },
    onRevoke: (permission2, run) => {
      const hooks = revokeHooks.get(permission2) ?? [];
      hooks.push(run);
      revokeHooks.set(permission2, hooks);
    },
    hasGrant: (permission2) => grantTable.has(permission2),
    grants: () => grantTable.list(),
    disable: () => {
      enabled = false;
      backend.revoke();
      recheck();
    },
    enable: () => {
      enabled = true;
      backend.activate();
    },
    isEnabled: () => enabled,
    setVisible: (next) => {
      if (typeof next !== "boolean") throw new TestHostInvalid("setVisible", ["visible must be a boolean"]);
      visible = next;
    },
    isVisible: () => visible,
    userInput: (input) => {
      if (typeof input !== "object" || input === null || typeof input.text !== "string") throw new TestHostInvalid("userInput", ["text must be a string"]);
      inputSequence += 1;
      lastInput = { seq: inputSequence, at: clock.now() };
    },
    deliveries: (surface) => deliveries.filter((delivery) => surface === void 0 || delivery.surface === surface),
    setBackendHandler: (method2, handle) => {
      backend.setHandler(method2, handle);
    },
    events: () => [...events]
  };
}

var PROGRAM_REPLY_VALIDATOR = Object.freeze({
  requestMaxBytes: PROGRAM_API_MAX_REQUEST_BYTES_V1,
  call: ProgramCallV1Schema,
  reply: ProgramReplyV1Schema,
  resultByOperation: ProgramResultByOperationV1Schema
});
var AI_OP_ENDPOINTS = Object.freeze({
  getOptions: "ai.getOptions",
  openSession: "ai.openSession",
  complete: "ai.complete",
  send: "session.send",
  interrupt: "session.interrupt",
  close: "session.close"
});
var HOST_BASE = "tuq-test-host://plugin";
var stringField = (raw, key4) => typeof raw === "object" && raw !== null && key4 in raw && typeof raw[key4] === "string" ? raw[key4] : "";
var isProgramOperation = (raw) => PLUGIN_PROGRAM_OPERATION_NAMES_V1.some((operation) => operation === stringField(raw, "operation"));
var aiArgs = (raw) => {
  if (typeof raw !== "object" || raw === null || !("image" in raw)) return raw;
  const image = raw.image;
  if (typeof image !== "object" || image === null || !("dataBase64" in image) || typeof image.dataBase64 !== "string") return raw;
  return { ...raw, image: { mime: image.mime, data: Buffer.from(image.dataBase64, "base64") } };
};
function viewRoute(channel, raw) {
  if (channel === PLUGIN_CORE_CHANNELS.STORAGE) return { id: `storage.${stringField(raw, "op")}`, args: raw };
  if (channel === PLUGIN_CORE_CHANNELS.SETTINGS) return { id: `settings.${stringField(raw, "op")}`, args: raw };
  if (channel === PLUGIN_BACKEND_INVOKE_CHANNEL) return { id: "backend.call", args: raw };
  if (channel === PLUGIN_AI_CHANNELS.REQUEST) {
    const id7 = AI_OP_ENDPOINTS[stringField(raw, "op")];
    if (id7 === void 0) throw new TestHostNotModeled("view", `ai ${stringField(raw, "op")}`);
    return { id: id7, args: raw };
  }
  if (channel === PLUGIN_PROGRAM_API_CHANNELS_V1.REQUEST) return { id: `program.call:${stringField(raw, "operation")}`, args: raw };
  throw new TestHostNotModeled("view", channel);
}
function hostRoute(request) {
  const { capabilityId: capabilityId2, method: method2, args } = request;
  if (capabilityId2 === PLUGIN_HOST_DATA_CAPABILITIES.aiChat) {
    const id7 = AI_OP_ENDPOINTS[method2];
    if (id7 === void 0) throw new TestHostNotModeled("backend", `${capabilityId2} ${method2}`);
    return { id: id7, args: aiArgs(args[0]) };
  }
  if (capabilityId2 === PLUGIN_HOST_DATA_CAPABILITIES.programApi && method2 === PLUGIN_HOST_DATA_METHODS.programApi.call) {
    return { id: `program.call:${stringField(args[0], "operation")}`, args: args[0] };
  }
  if (capabilityId2 === PLUGIN_HOST_DATA_CAPABILITIES.pluginState && (method2 === PLUGIN_HOST_DATA_METHODS.pluginState.readPage || method2 === PLUGIN_HOST_DATA_METHODS.pluginState.writeBatch || method2 === PLUGIN_HOST_DATA_METHODS.pluginState.deleteBatch)) {
    return { id: `pluginState.${method2}`, args };
  }
  throw new TestHostNotModeled("backend", `${capabilityId2} ${method2}`);
}
var unmodeledMembers = (name, members) => Object.freeze(
  Object.fromEntries(members.map((member) => [member, () => {
    throw new TestHostNotModeled("backend", `${name}.${member}`);
  }]))
);
function createTestHost(options) {
  const core = createTestHostCore({
    manifest: options.manifest,
    grants: options.grants,
    visible: options.visible,
    clock: options.clock,
    limits: options.limits,
    provider: options.provider,
    pluginStateAuthority: options.pluginStateAuthority,
    programReplyValidator: PROGRAM_REPLY_VALIDATOR
  });
  const internalSeq = /* @__PURE__ */ new Set();
  const viewListeners = /* @__PURE__ */ new Map();
  const flushed = { view: 0, backend: 0 };
  let hostClient = null;
  const pushViewEvents = () => {
    const pending = core.deliveries("view");
    while (flushed.view < pending.length) {
      const delivery = pending[flushed.view];
      flushed.view += 1;
      for (const listener of viewListeners.get(PLUGIN_AI_CHANNELS.EVENT) ?? []) listener(void 0, { sessionId: delivery.sessionId, turnId: delivery.turnId, event: delivery.event });
    }
  };
  const pushBackendEvents = () => {
    const pending = core.deliveries("backend");
    while (flushed.backend < pending.length) {
      const delivery = pending[flushed.backend];
      flushed.backend += 1;
      hostClient?.receive({ protocolVersion: EXTERNAL_HOST_PROTOCOL_VERSION, kind: "ext-capability-event", capabilityId: PLUGIN_HOST_DATA_CAPABILITIES.aiChat, event: "turn", sessionId: delivery.sessionId, turnId: delivery.turnId, turn: delivery.event });
    }
  };
  const dispatchInternal = async (id7, args) => {
    const envelope3 = await core.dispatch("backend", id7, args);
    const record = core.calls().find((call) => call.args === args);
    if (record !== void 0) internalSeq.add(record.seq);
    return envelope3;
  };
  const settings = createExternalSettings(void 0, false);
  const refreshSettings = async () => {
    const envelope3 = await dispatchInternal("settings.all", {});
    settings.apply({ protocolVersion: EXTERNAL_HOST_PROTOCOL_VERSION, kind: "ext-settings", enabled: envelope3.ok, values: envelope3.ok ? envelope3.value : {} });
  };
  const settle = async () => {
    pushViewEvents();
    pushBackendEvents();
    await refreshSettings();
  };
  const answerHost = async (request) => {
    const route = hostRoute(request);
    const envelope3 = await core.dispatch("backend", route.id, route.args);
    pushBackendEvents();
    const requestId5 = request.requestId;
    if (request.capabilityId === PLUGIN_HOST_DATA_CAPABILITIES.aiChat) return { protocolVersion: EXTERNAL_HOST_PROTOCOL_VERSION, requestId: requestId5, ok: true, value: envelope3 };
    if (envelope3.ok) return { protocolVersion: EXTERNAL_HOST_PROTOCOL_VERSION, requestId: requestId5, ok: true, value: envelope3.value };
    return { protocolVersion: EXTERNAL_HOST_PROTOCOL_VERSION, requestId: requestId5, ok: false, error: { code: envelope3.error, message: envelope3.error } };
  };
  const serveHost = (value) => {
    const parsed = PluginHostDataRequestV1Schema.safeParse(value);
    if (!parsed.success) throw new TestHostNotModeled("backend", "a host request that is not a capability call");
    const request = parsed.data;
    answerHost(request).catch((error) => ({ protocolVersion: EXTERNAL_HOST_PROTOCOL_VERSION, requestId: request.requestId, ok: false, error: { code: "plugin_host_unavailable", message: error instanceof Error ? error.message : String(error) } })).then((response) => {
      hostClient?.receive(response);
    });
  };
  const rawClient = createPluginHostApiClient({ pluginId: core.manifest.id, send: serveHost });
  hostClient = rawClient;
  const guardedAi = Object.freeze({
    ...rawClient.api.ai,
    openSession: (request) => {
      if (request.resume !== void 0) throw new TestHostNotModeled("backend", "ai attachSession");
      return rawClient.api.ai.openSession(request);
    }
  });
  const guardedProgram = Object.freeze({
    call: (operation, input, callOptions) => {
      if (!core.modeled().some((entry2) => entry2.surface === "backend" && entry2.id === `program.call:${operation}`)) throw new TestHostNotModeled("backend", `program.call:${operation}`);
      return rawClient.api.program.call(operation, input, callOptions);
    }
  });
  const hostApi = Object.freeze({
    ...rawClient,
    api: Object.freeze({
      ...rawClient.api,
      ai: guardedAi,
      program: guardedProgram,
      secrets: unmodeledMembers("secrets", ["get", "set", "remove", "list", "available"]),
      workRecords: unmodeledMembers("workRecords", ["readPage", "subscribeSettledChanges"]),
      agentDirectory: unmodeledMembers("agentDirectory", ["readPage"]),
      projectDirectory: unmodeledMembers("projectDirectory", ["readPage"])
    }),
    capabilities: unmodeledMembers("capabilities", ["list", "openLink", "onChange"]),
    processHelpers: unmodeledMembers("processHelper", ["openBundledHelper", "write", "read", "close"])
  });
  const init = {
    version: EXTERNAL_HOST_VERSION,
    pluginId: core.manifest.id,
    installDir: `${HOST_BASE}/install`,
    dataDir: `${HOST_BASE}/data`,
    entry: `${HOST_BASE}/backend`,
    assetPacks: {},
    allowAddons: false,
    corePackaged: false,
    grantedPermissions: [...core.grants()]
  };
  const port = {
    invoke: async (channel, raw) => {
      if (channel === PLUGIN_PROGRAM_API_CHANNELS_V1.REQUEST && !isProgramOperation(raw)) {
        core.reject("view", `program.call:${stringField(raw, "operation")}`, raw, { ok: true, value: PROGRAM_INVALID_REPLY });
        return PROGRAM_INVALID_REPLY;
      }
      const route = viewRoute(channel, raw);
      const envelope3 = await core.dispatch("view", route.id, route.args);
      pushViewEvents();
      pushBackendEvents();
      if (route.id.startsWith("settings.")) await refreshSettings();
      if (channel === PLUGIN_PROGRAM_API_CHANNELS_V1.REQUEST && envelope3.ok) return envelope3.value;
      return envelope3;
    },
    on: (channel, listener) => {
      const set = viewListeners.get(channel) ?? /* @__PURE__ */ new Set();
      set.add(listener);
      viewListeners.set(channel, set);
    },
    removeListener: (channel, listener) => {
      viewListeners.get(channel)?.delete(listener);
    }
  };
  return {
    view: createPluginViewApi(port, () => HOST_BASE),
    backend: createExternalContext(init, hostApi, settings.api),
    manifest: core.manifest,
    clock: core.clock,
    ai: core.ai,
    inject: (surface, id7, code2, times) => {
      core.inject(surface, id7, code2, times);
    },
    setBackendHandler: (method2, handle) => {
      core.setBackendHandler(method2, handle);
    },
    grant: async (permission2) => {
      core.grant(permission2);
      await settle();
    },
    revoke: async (permission2) => {
      core.revoke(permission2);
      hostClient?.revokePermission(permission2);
      await settle();
    },
    disable: async () => {
      core.disable();
      await settle();
    },
    enable: async () => {
      core.enable();
      await settle();
    },
    grants: () => core.grants(),
    setVisible: (visible) => {
      core.setVisible(visible);
    },
    userInput: (input) => {
      core.userInput(input);
    },
    advance: (ms) => {
      core.clock.advance(ms);
      pushViewEvents();
      pushBackendEvents();
    },
    calls: (filter) => core.calls(filter).filter((call) => !internalSeq.has(call.seq)),
    deliveries: (surface) => core.deliveries(surface),
    events: () => core.events(),
    close: () => {
      hostClient?.dispose();
    }
  };
}
export {
  TestHostInvalid,
  TestHostNotModeled,
  TestHostRefused,
  createManualClock,
  createTestHost
};
export const GENERATED_FROM = ".teamuq/scripts/plugin-endpoints/testhost/entry.ts";
