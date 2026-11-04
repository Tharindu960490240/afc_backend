const AppError = require("../utils/AppError");

// validate(schema, "body" | "query" | "params") replaces req[part] with the parsed (clean) value.
const validate = (schema, part = "body") => (req, res, next) => {
  const result = schema.safeParse(req[part]);
  if (!result.success) {
    const errors = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join(".") || "_";
      if (!errors[key]) errors[key] = issue.message;
    }
    return next(new AppError(400, "Please check the highlighted fields.", { errors }));
  }
  if (part === "query") Object.defineProperty(req, "query", { value: result.data, writable: true });
  else req[part] = result.data;
  next();
};
module.exports = validate;
