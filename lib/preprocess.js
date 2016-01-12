var targz = require('tar.gz');

function Preprocess(processors){

  return function(file, stream, cb) {

    // copy the array to p
    var p = (processors || []).slice();

    (function fn(file, stream, cb) {
      if (p.length == 0) {
         cb(file, stream);
         return;
      }
      p.shift()(file, stream, function(file, stream, loop) {
        if (loop) {
          cb(file, stream, loop);
        } else {
          fn(file, stream, cb);
        }
      });
    })(file, stream, cb);
  }
}

function size() {

  return function(file, fileStream, cb) {
    var lengthStream = require('length-stream');

    function lengthListener(length) {
      if (file.compression) {
        file.compression.size = length;
        file.compressedSize = length;
      } else {
        file.size = length;
      }
    }
    var stream = lengthStream(lengthListener);

    fileStream.pipe(stream)
    cb(file, stream);
  }
}

function digest(algorithm, digestEncoding) {

  return function(file, fileStream, cb) {

    function listenerFn(resultDigest, length) {
      //file.digest = file.digest || {};
      if (file.compression) {
        //file.compression.digest = file.compression.digest || {};
        //file.compression.digest[algorithm] = resultDigest;
        file.compression[algorithm] = resultDigest;
      } else {
        file[algorithm] = resultDigest;
      }
    }

    var stream;
    algorithm = algorithm || 'md5';
    digestEncoding = digestEncoding || 'hex';

    if (algorithm == 'crc') {
      var CRC32Stream = require('crc32-stream');
      stream = new CRC32Stream();

      stream.on('end', function(err) {
        var crc = stream.digest();
        crc = digestEncoding == 'hex' ? crc.toString(16) : crc;
        listenerFn(crc, stream.size());
      });
      //stream.end();
    } else {
      var digestStream = require('digest-stream');
      stream = digestStream(algorithm, digestEncoding, listenerFn); // create instance
    }
    if (!stream) {
      cb(file, fileStream);
      return;
    }
    fileStream.pipe(stream)
    cb(file, stream);
  }
}

function extract(){

  return function(file, fileStream, cb) {
    console.log('start process', file);
    function onTarEntry(entry, stream) {

      file.mimetype='';
      if (entry.props) {
        file.tarEntry = entry.props;
        file.originalname = entry.props.path;//entry.type == 'file' ? entry.props.path : '';
        //stream = entry;
      } else {
      //  file.tarEntry = entry;
      //  file.originalname = '';//entry.type ? entry.props.path : '';
      }
      // inlude true to loop preprocess
      cb(file, entry, true);
    }

    if (file.originalname.indexOf('.tar.gz') > -1 ||
        file.originalname.indexOf('.tgz')    > -1 ||
        [/*'application/x-gzip' <- this will include normall gzip files,*/ 'application/x-tar',  ' application/x-compressed'].indexOf(file.mimetype) == 0) {


      var parse = targz().createParseStream();

      parse.on('entry', onTarEntry);

      fileStream.pipe(parse);

    } else if (file.mimetype == 'application/x-bzip2' || file.originalname.indexOf('.bz2') > -1) {
      var bz2 = require('unbzip2-stream');
      //var stream = bz2();

      /*var stream = new require('stream').PassThrough();
      var bz2 = require('seek-bzip');
      bz2.decode(fileStream, stream);*/

      var stream = fileStream.pipe(bz2());
      file.originalname = file.originalname.slice(0, -4);
      file.mimetype = '';
      cb(file, stream, true);

    } else if (file.mimetype == 'application/x-gzip' || file.originalname.indexOf('.gz') > -1) {
      var zlib = require('zlib');
      var stream = zlib.createGunzip();
      fileStream.pipe(stream);
      //stream.on('end', function() {
        file.originalname = file.originalname.slice(0, -3);
        file.mimetype = '';
        cb(file, stream, true);
      //});
    } else if (file.mimetype == 'application/tar' || file.originalname.indexOf('.tar') > -1) {
/*      var tar = require('tar-stream')
      var parse = tar.extract()
      // Capture the entry event
      parse.on('entry', function(header, stream, callback) {
        console.log(header);
        onTarEntry(header, stream);
        stream.on('end', function() {
          callback() // ready for next entry
        })

        stream.resume() // just auto drain the stream
      });
*/

      var tar = require('tar');

      var parse = fileStream.pipe(tar.Parse());

      parse.on('entry', function(e){

    console.error("entry", e.props)
    //  e.on("data", function (c) {
      //      console.error("  >>>" + c.toString().replace(/\n/g, "\\n"))
        //  })
          /*e.on("end", function () {
            console.error("  <<<EOF");
            onTarEntry(e, parse);

          })*/
        });

    } else if (file.mimetype == 'application/zip') {
      // TODO zip support
      cb(file, fileSream);
    } else {
      cb(file, fileStream);
    }
  }
}

function compress(type, options) {

  return function(file, fileStream, cb) {

    var stream;

    if (typeof type == 'function') {
      stream = type();
    } else {
      var zlib = require('zlib');
      if (type == 'gzip') {
        stream = zlib.createGzip(options);
      } else if (type == 'deflate') {

        var DeflateCRC32Stream = require('crc32-stream').DeflateCRC32Stream;
        stream = new DeflateCRC32Stream(options);
      /*  stream = zlib.createDeflate(options);
      } else if (type == 'deflateraw') {
        stream = zlib.createDeflateRaw(options);
      */} else if (type == 'lzma') {
        //var lzma = require('lzma-native');
        //stream = lzma.createCompressor(options);
        var lzma = require('lzma');
        stream = lzma.createXz(options);
        //cb(file, stream);
        //return;
      }
    }

    if (!stream) {
      // throw error?
      cb(file, fileStream);
      return;
    }

    stream.on('finish', function () {
      file.compression = {
        type: type
      };

    });

    fileStream.pipe(stream);
    cb(file, stream);
  }
}

module.exports = Preprocess;
module.exports.size = size;
module.exports.extract = extract;
module.exports.digest = digest;
module.exports.compress = compress;
