Blobs2.configure = function (options) {
  check(options, new SimpleSchema({
    filesPerFolder: { type: Number, optional: true, min: 1 },
    storageRootPath: { type: String },
  }));

  // default to 10000 files per folder
  if (!options.filesPerFolder) options.filesPerFolder = 10000;

  Blobs2._configOptions = options;
};

Blobs2.configure({
  filesPerFolder: 10000,
  storageRootPath: "/filestore",
});

Blobs2.create = function (pathOnServer, associated_object, callback) {
  check(pathOnServer, String);
  check(associated_object, new SimpleSchema({
    collection_name: { type: String },
    mongo_id: { type: String },
  }));
  if (typeof callback !== "function") throw new Meteor.Error("no-callback");

  // figure out which folder to put it in
  var biggestFolder = BlobMetadata.findOne({}, { sort: { folder_num: -1 } });
  var folder_num;

  // keep track of whether we need to create a folder
  var tryToCreateFolder = false;

  // if we need to make a new folder entry do so
  if (!biggestFolder ||
      biggestFolder.file_count >= Blobs2._configOptions.filesPerFolder) {
    // figure out the new folder value
    folder_num = 0;
    if (biggestFolder) {
      folder_num = biggestFolder.folder_num + 1;

      if (folder_num >= Blobs2._configOptions.filesPerFolder) {
        // hopefully this code becomes obselete before this happens
        callback(new Meteor.Error("too-many-blobs"));
        return;
      }
    }

    // make sure there's one entry with `folder_num` set correctly
    var query = { folder_num: folder_num };
    var upsertRet = BlobMetadata.upsert(query, { $set: query });

    // if that entry doesn't have the `file_count` defined, define it
    // (this must be a single transaction otherwise it might reset the count)
    BlobMetadata.update({
      folder_num: folder_num,
      file_count: { $exists: false }
    }, {
      $set: { file_count: 0 }
    });

    tryToCreateFolder = true;
  } else {
    folder_num = biggestFolder.folder_num;
  }

  // create the blob
  // NOTE: don't set associated_object until it's actually done so if there's
  // an error somewhere along the line it's cleaned up
  var storage_path = "" + folder_num;
  var blobId = Blobs2.insert({
    storage_path: storage_path,
    file_name: path.basename(pathOnServer),
  });

  // move the file to its new home
  var rootPath = Blobs2._configOptions.storageRootPath;
  var newPath = path.join(rootPath, storage_path, blobId);

  function moveIt(err, out) {
    // only throw an error if the problem is something other than the folder
    // already existing
    if (err && err.code !== "EEXIST")  {
      callback(err);
    } else {
      fs.rename(pathOnServer, newPath,
            Meteor.bindEnvironment(function (err, out) {
        if (err) {
          callback(err);
        } else {
          Blobs2.update(blobId, {
            $set: { associated_object: associated_object }
          });

          BlobMetadata.update({ folder_num: folder_num }, {
            $inc: { file_count: 1 }
          });

          callback(null, Blobs2.findOne(blobId));
        }
      }));
    }
  }

  if (tryToCreateFolder) {
    fs.mkdir(path.join(rootPath, storage_path), Meteor.bindEnvironment(moveIt));
  } else {
    moveIt();
  }
};