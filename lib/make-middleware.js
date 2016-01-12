var is = require('type-is')
var Busboy = require('busboy')
var extend = require('xtend')
var onFinished = require('on-finished')
var appendField = require('append-field')

var Counter = require('./counter')
var makeError = require('./make-error')
var FileAppender = require('./file-appender')
var removeUploadedFiles = require('./remove-uploaded-files')
var Preprocess = require('./preprocess')

function drainStream (stream) {
  stream.on('readable', stream.read.bind(stream))
}

function makeMiddleware (setup) {
  return function multerMiddleware (req, res, next) {

    var options = setup()
    var limits = options.limits
    var storage = options.storage
    var fileFilter = options.fileFilter
    var fileStrategy = options.fileStrategy
    var preprocess = Preprocess(options.preprocessors)
    var appender = new FileAppender(fileStrategy, req)
    var isDone = false
    var readFinished = false
    var errorOccured = false
    var pendingWrites = new Counter()
    var uploadedFiles = []

    var busboy

    function done (err) {
      if (isDone) return
      isDone = true

      if (busboy) {
        req.unpipe(busboy)
        drainStream(req)
        busboy.removeAllListeners()
      }
      onFinished(req, function () { next(err) })
    }

    function indicateDone () {
      if (readFinished && pendingWrites.isZero() && !errorOccured) done()
    }

    function abortWithError (uploadError) {
      errorOccured = true

      pendingWrites.onceZero(function () {
        function remove (file, cb) {
          storage._removeFile(req, file, cb)
        }

        removeUploadedFiles(uploadedFiles, remove, function (err, storageErrors) {
          if (err) return done(err)

          uploadError.storageErrors = storageErrors
          done(uploadError)
        })
      })
    }

    function abortWithCode (code, optionalField) {
      abortWithError(makeError(code, optionalField))
    }

    function processFile(fieldname, fileStream, filename, encoding, mimetype) {

      // don't attach to the files object, if there is no file
      if (!filename) return fileStream.resume()

      // Work around bug in Busboy (https://github.com/mscdex/busboy/issues/6)
      if (limits && limits.hasOwnProperty('fieldNameSize')) {
        if (fieldname.length > limits.fieldNameSize) return abortWithCode('LIMIT_FIELD_KEY')
      }

      var file = {
        fieldname: fieldname,
        originalname: filename,
        encoding: encoding,
        mimetype: mimetype
      }

      var placeholder = appender.insertPlaceholder(file)

      fileFilter(req, file, function (err, includeFile) {
        if (err) {
          appender.removePlaceholder(placeholder)
          return abortWithError(err)
        }

        if (!includeFile) {
          appender.removePlaceholder(placeholder)
          return fileStream.resume()
        }

        preprocess(file, fileStream, function(file, fileStream, loop){
          if (loop) {
            console.log('loop', file);
            appender.removePlaceholder(placeholder)
            processFile(file.fieldname, fileStream, file.originalname, file.encoding, file.mimetype)
          } else {

            var aborting = false
            pendingWrites.increment()

            Object.defineProperty(file, 'stream', {
              configurable: true,
              enumerable: false,
              value: fileStream
            })

            fileStream.on('error', function (err) {
              pendingWrites.decrement()
              abortWithError(err)
            })

            fileStream.on('limit', function () {
              aborting = true
              abortWithCode('LIMIT_FILE_SIZE', fieldname)
            })

            storage._handleFile(req, file, function (err, info) {
              if (aborting) {
                appender.removePlaceholder(placeholder)
                uploadedFiles.push(extend(file, info))
                return pendingWrites.decrement()
              }

              if (err) {
                appender.removePlaceholder(placeholder)
                pendingWrites.decrement()
                return abortWithError(err)
              }

              if (info.size && file.size && file.compression) {
                info.compressedSize = info.size;
                delete info.size;
              }

                                    console.log('saved file ', info);
              var fileInfo = extend(file, info)

              appender.replacePlaceholder(placeholder, fileInfo)
              uploadedFiles.push(fileInfo)
              pendingWrites.decrement()
              indicateDone()
            })
          }
        })
      })
    }

    if (!is(req, ['multipart'])) {
        processFile(req.headers['x-filename'], req, req.headers['x-filename'], '7bit', req.get('Content-Type'))
        readFinished = true
    } else {

      req.body = Object.create(null)

      try {
        busboy = new Busboy({ headers: req.headers, limits: limits })
      } catch (err) {
        return next(err)
      }
      // handle text field data
      busboy.on('field', function (fieldname, value, fieldnameTruncated, valueTruncated) {
        if (fieldnameTruncated) return abortWithCode('LIMIT_FIELD_KEY')
        if (valueTruncated) return abortWithCode('LIMIT_FIELD_VALUE', fieldname)

        // Work around bug in Busboy (https://github.com/mscdex/busboy/issues/6)
        if (limits && limits.hasOwnProperty('fieldNameSize')) {
          if (fieldname.length > limits.fieldNameSize) return abortWithCode('LIMIT_FIELD_KEY')
        }

        appendField(req.body, fieldname, value)
      })

      // handle files
      busboy.on('file', processFile)

      busboy.on('error', function (err) { abortWithError(err) })
      busboy.on('partsLimit', function () { abortWithCode('LIMIT_PART_COUNT') })
      busboy.on('filesLimit', function () { abortWithCode('LIMIT_FILE_COUNT') })
      busboy.on('fieldsLimit', function () { abortWithCode('LIMIT_FIELD_COUNT') })
      busboy.on('finish', function () {
        readFinished = true
        indicateDone()
      })

      req.pipe(busboy)
    }
  }
}

module.exports = makeMiddleware
