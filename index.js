var path = require('path');
var fs = require('fs');

var _ = require('lodash');

var Q = require('q');
var FSQ = require("q-io/fs");

var globby = require('./lib/globby-as-promise');


var logStackTrace = function(e) { console.error(e.stack) };
// By default files with leading dot are not matches to '*'
const DEFAULT_GLOBBY_OPTIONS = { dot: true };

/**
 * @param {String} patternsFilename - Path to file with patterns
 * @param {Object} [globbyOptions] - Options for globby search
 * @param {Boolean} [dryRun]
 * @see https://github.com/isaacs/node-glob#options
 */
var PackageCleaner = function (patternsFilename, globbyOptions, dryRun) {
    console.assert(patternsFilename, 'Path to file with patterns not defined');
    console.assert(fs.existsSync(patternsFilename), 'File with patterns "' + patternsFilename + '" does not exist');

    this.globbyOptions = _.defaults({}, globbyOptions, DEFAULT_GLOBBY_OPTIONS);

    dryRun === true && this.setDryRunMethods();

    this.patternsFilename = patternsFilename;
    this.filesToKeep = null;
    this.pathsToDelete = [];
    this.dirsToKeep = null;

    _.bindAll(this);
};

/**
 * @returns {Q.Promise}
 */
PackageCleaner.prototype.clean = function() {
    return Q.when(this.readPatterns())
        .then(this.parsePatterns)
        .then(this.getFilesToKeep)
        .then(this.setFilesToKeep)
        .then(this.searchFilesToDelete)
        .then(this.searchEmptyFiles)
        .then(this.deleteFiles)
        .catch(logStackTrace)
        .done();
};

PackageCleaner.prototype.move = function(outPath) {
    return Q.when(this._makeDirMethod(outPath))
        .then(this.readPatterns)
        .then(this.parsePatterns)
        .then(this.getFilesToKeep)
        .then(_.partial(this.copyFilesToKeep, outPath))
        .catch(logStackTrace)
        .done();
};

PackageCleaner.prototype.readPatterns = function() {
    return FSQ.read(this.patternsFilename);
};

/**
 * @param {String} content
 * @returns {String[]}
 */
PackageCleaner.prototype.parsePatterns = function(content) {
    return _(content.split('\n'))
            .invoke("trim")
            .compact()
            .value();
};

/**
 * @param {String[]} patterns
 * @returns {Q.Promise}
 */
PackageCleaner.prototype.getFilesToKeep = function(patterns) {
    return globby(patterns, this.globbyOptions);
};

/**
 * @param {String[]} filesToKeep
 */
PackageCleaner.prototype.setFilesToKeep = function(filesToKeep) {
    this.filesToKeep = _.map(filesToKeep, path.normalize);
    this.dirsToKeep = this.getDirsToKeep(this.filesToKeep);
};

/**
 * @param {String[]} filesToKeep
 * @returns {String[]}
 */
PackageCleaner.prototype.getDirsToKeep = function(filesToKeep) {

    function parsePathToDirs(dirsToKeep, dirPath) {
        var dirs = dirPath.split(path.sep);
        _.reduce(dirs, function(p, d) {
            var newDir = p ? path.join(p, d): d;
            dirsToKeep.push(newDir);
            return newDir;
        }, "");

        return dirsToKeep;
    }

    return _.chain(filesToKeep)
        .map(path.dirname) // TODO can be dangerous, cuz 'pages/search' he will convert to 'pages/'
        .map(path.normalize)
        .reduce(parsePathToDirs, [])
        .uniq()
        .sort()
        .value();
};

/**
 * @param {String} outPath - output dir path
 * @param {String[]} filesToKeep
 * @returns {Q.Promise}
 */
PackageCleaner.prototype.copyFilesToKeep = function(outPath, filesToKeep) {
    var that = this;

    function newPath(p) {
        return path.join(outPath, p);
    }

    var createDirsPromises = _.chain(filesToKeep)
        .map(path.dirname)
        .map(path.normalize)
        .uniq()
        .map(newPath)
        .map(this._makeTreeMethod)
        .value();

    return Q.all(createDirsPromises)
        .then(function() {
            var copyFilesPromises = filesToKeep.map(function(p) { return that._copyMethod(p, newPath(p)) });
            return Q.all(copyFilesPromises);
        });
};

/**
 * @returns {Q.Promise}
 */
PackageCleaner.prototype.searchFilesToDelete = function() {
    return FSQ.listTree('', this._guard);
};

/**
 * Adds files and dirs to delete list
 * Functions calls as a argument for q-io.listTree
 * @param {String} p - path to file or dir
 * @param {Object} stat
 * @returns {Boolean|null}
 * @see https://github.com/kriskowal/q-io#listtreepath-guardpath-stat
 * @private
 */
PackageCleaner.prototype._guard = function(p, stat) {
    if (p === '.') return true;

    if (stat.isDirectory()) {
        if (this._isItDirToKeep(p)) return true;
    } else {
        if (this._isItFileToKeep(p)) return true;
    }
    this.addPathToDeleteList(p);
    return null;
};

/**
 * @param {String} path
 * @private
 */
PackageCleaner.prototype.addPathToDeleteList = function(path) {
    this.pathsToDelete.push(path);
};

/**
 * Search empty files and add it to delete list
 * @returns {Q.Promise}
 */
PackageCleaner.prototype.searchEmptyFiles = function() {
    var that = this;

    var promises = this.filesToKeep.map(function(p) {
        return that._statMethod(p)
            .then(function(stat) { return { path: p, size: stat.size } })
    });

    return Q.all(promises).then(function(files) {
        _.chain(files)
            .reject('size')
            .pluck('path')
            .map(that.addPathToDeleteList);
    });
};

PackageCleaner.prototype.deleteFiles = function() {
    var that = this,
        promises = this.pathsToDelete.map(function(p) {
            return FSQ.isDirectory(p).then(function(isDir) {
                return isDir ? that._deleteDirMethod(p) : that._deleteFileMethod(p);
            });
        });

    return Q.all(promises);
};

PackageCleaner.prototype.setDryRunMethods = function() {
    this._deleteDirMethod = function(p) { console.log('rm -rf ' + p)};
    this._deleteFileMethod = function(p) { console.log('rm ' + p)};
    this._copyMethod = function(f, t) { console.log('cp ' + f + ' ' + t)};
    this._makeDirMethod = this._makeTreeMethod = function(p) { console.log('mkdir ' + p)};
    return this;
};

PackageCleaner.prototype._statMethod = function(p) { return FSQ.stat(p) };

PackageCleaner.prototype._deleteFileMethod = function(p) { return FSQ.remove(p) };

PackageCleaner.prototype._deleteDirMethod = function(p) { return FSQ.removeTree(p) };

PackageCleaner.prototype._copyMethod = function(f, t) { return FSQ.copy(f,t) };

PackageCleaner.prototype._makeTreeMethod = function(p) { return FSQ.makeTree(p) };

PackageCleaner.prototype._makeDirMethod = function(p) { return FSQ.makeDirectory(p) };

PackageCleaner.prototype._isItFileToKeep = function(file) {
    return _.contains(this.filesToKeep, file);
};

PackageCleaner.prototype._isItDirToKeep = function(dir) {
    return _.contains(this.dirsToKeep, dir);
};

module.exports = PackageCleaner;
