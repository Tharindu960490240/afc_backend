const multer = require("multer");
const env = require("../config/env");
const AppError = require("../utils/AppError");

// Files are held in memory (max MAX_UPLOAD_MB), checked, then written by fileStorage.
const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadMb * 1024 * 1024, files: 1, fields: 10 },
});

// uploadOne("file") -> req.file, with friendly errors
const uploadOne = (field) => (req, res, next) =>
  uploader.single(field)(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return next(new AppError(413, `The file is too large. The limit is ${env.maxUploadMb} MB.`));
    }
    return next(new AppError(400, "The file could not be uploaded. Please try again."));
  });

module.exports = { uploadOne };
