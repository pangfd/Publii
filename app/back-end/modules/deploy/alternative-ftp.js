/*
 * Class used to upload files to the FTP(S) server
 */

const fs = require('fs-extra');
const path = require('path');
const ftp = require('basic-ftp');
const passwordSafeStorage = require('keytar');
const slug = require('./../../helpers/slug');
const normalizePath = require('normalize-path');

class FTP {
    constructor(deploymentInstance = false) {
        this.deployment = deploymentInstance;
        this.connection = false;
        this.debugOutput = [];
        this.econnresetCounter = 0;
        this.softUploadErrors = {};
        this.hardUploadErrors = [];
        this.logTimer = false;
    }

    async initConnection() {
        let self = this;
        let waitForTimeout = true;
        let ftpPassword = this.deployment.siteConfig.deployment.password;
        let account = slug(this.deployment.siteConfig.name);
        let secureConnection = false;

        this.connection = new ftp.Client();

        if(ftpPassword === 'publii ' + account) {
            ftpPassword = await passwordSafeStorage.getPassword('publii', account);
        }

        if(this.deployment.siteConfig.deployment.protocol !== 'ftp') {
            secureConnection = 'control';
        }

        let connectionParams = {
            host: this.deployment.siteConfig.deployment.server,
            port: this.deployment.siteConfig.deployment.port,
            user: this.deployment.siteConfig.deployment.username,
            password: ftpPassword,
            secure: secureConnection,
            secureOptions: {
                host: this.deployment.siteConfig.deployment.server,
                port: this.deployment.siteConfig.deployment.port,
                user: this.deployment.siteConfig.deployment.username,
                password: ftpPassword
            }
        };

        process.send({
            type: 'web-contents',
            message: 'app-uploading-progress',
            value: {
                progress: 6,
                operations: false
            }
        });

        process.send({
            type: 'web-contents',
            message: 'app-connection-in-progress'
        });

        this.connection.ftp.log = this.connectionDebugger.bind(this);

        try {
            await this.connection.access(connectionParams);
            waitForTimeout = false;
            process.send({
                type: 'web-contents',
                message: 'app-connection-success'
            });

            this.deployment.setInput();
            this.deployment.setOutput();
            this.deployment.prepareLocalFilesList();

            process.send({
                type: 'web-contents',
                message: 'app-uploading-progress',
                value: {
                    progress: 7,
                    operations: false
                }
            });

            this.downloadFilesList();
        } catch (err) {
            console.log(err)
        }

        setTimeout(function() {
            if(waitForTimeout === true) {
                self.connection.destroy();
                self.deployment.saveConnectionErrorLog('Request timeout...');
                clearInterval(self.logTimer);
                self.saveConnectionDebugLog();

                process.send({
                    type: 'web-contents',
                    message: 'app-connection-error'
                });

                setTimeout(function () {
                    process.exit();
                }, 1000);
            }
        }, 20000);
    }

    error (err) {
        this.deployment.outputLog.push('- - - FTP ERROR - - -');
        this.deployment.outputLog.push(err);
        this.deployment.outputLog.push('- - - - - - - - - - -');

        if(typeof err === "string" && err.indexOf('ECONNRESET') > -1) {
            this.econnresetCounter++;

            if(this.econnresetCounter <= 5) {
                return;
            }
        }

        clearInterval(this.logTimer);
        this.deployment.saveConnectionErrorLog(err);
        this.saveConnectionDebugLog();

        if(waitForTimeout) {
            waitForTimeout = false;
            this.connection.close();

            process.send({
                type: 'web-contents',
                message: 'app-connection-error'
            });

            setTimeout(function () {
                process.exit();
            }, 1000);
        }
    }

    close () {
        clearInterval(this.logTimer);
        this.saveConnectionDebugLog();

        setTimeout(function () {
            process.exit();
        }, 1000);
    }

    downloadFilesList() {
        let remotePath = normalizePath(path.join(this.deployment.outputDir, 'files.publii.json'));
        let localPath = normalizePath(path.join(this.deployment.inputDir, 'files.publii.json'));

        try {
            await this.connection.download(fs.createWriteStream(localPath), remotePath);
            this.deployment.outputLog.push('<- files.publii.json');

            process.send({
                type: 'web-contents',
                message: 'app-uploading-progress',
                value: {
                    progress: 8,
                    operations: false
                }
            });

            this.deployment.compareFilesList(true);
        } catch (err) {
            console.log('(!) ERROR WHILE DOWNLOADING files-remote.json');
            console.log(err);
            this.deployment.compareFilesList(false);
        }
    }

    uploadNewFileList() {
        let self = this;

        process.send({
            type: 'web-contents',
            message: 'app-uploading-progress',
            value: {
                progress: 99,
                operations: [self.deployment.currentOperationNumber ,self.deployment.operationsCounter]
            }
        });

        this.connection.put(
            normalizePath(path.join(this.deployment.inputDir, 'files.publii.json')),
            normalizePath(path.join(this.deployment.outputDir, 'files.publii.json')),
            function(err) {
                self.deployment.outputLog.push('-> files.publii.json');

                if (err) {
                    self.deployment.outputLog.push(err);
                }

                self.connection.logout(function(err) {
                    if (err) {
                        self.deployment.outputLog.push(err);
                    }

                    self.connection.end();
                    self.connection.destroy();
                });

                process.send({
                    type: 'web-contents',
                    message: 'app-uploading-progress',
                    value: {
                        progress: 100,
                        operations: false
                    }
                });

                process.send({
                    type: 'sender',
                    message: 'app-deploy-uploaded',
                    value: {
                        status: true,
                        issues: self.hardUploadErrors.length > 0
                    }
                });

                self.deployment.saveConnectionLog();

                setTimeout(function () {
                    process.exit();
                }, 1000);
            }
        );
    }

    uploadFile(input, output) {
        let self = this;

        this.connection.put(
            input,
            output,
            function (err) {
                if (err) {
                    self.deployment.outputLog.push(err);
                    self.deployment.outputLog.push('- - -ERROR UPLOAD FILE - - -');
                    self.deployment.outputLog.push(output);
                    self.deployment.outputLog.push(err);
                    self.deployment.outputLog.push('- - - - - - - - - - - - - - ');

                    setTimeout(() => {
                        if(!self.softUploadErrors[input]) {
                            self.softUploadErrors[input] = 1;
                        } else {
                            self.softUploadErrors[input]++;
                        }

                        if(self.softUploadErrors[input] <= 5) {
                            self.uploadFile(input, output);
                        } else {
                            self.hardUploadErrors.push(input);

                            self.deployment.currentOperationNumber++;
                            self.deployment.outputLog.push('UPL HARD ERR ' + input + ' -> ' + output);
                            self.deployment.progressOfUploading += self.deployment.progressPerFile;

                            process.send({
                                type: 'web-contents',
                                message: 'app-uploading-progress',
                                value: {
                                    progress: 8 + Math.floor(self.deployment.progressOfUploading),
                                    operations: [self.deployment.currentOperationNumber, self.deployment.operationsCounter]
                                }
                            });

                            self.deployment.uploadFile();
                        }
                    }, 500);
                } else {
                    self.deployment.currentOperationNumber++;
                    self.deployment.outputLog.push('UPL ' + input + ' -> ' + output);
                    self.deployment.progressOfUploading += self.deployment.progressPerFile;

                    process.send({
                        type: 'web-contents',
                        message: 'app-uploading-progress',
                        value: {
                            progress: 8 + Math.floor(self.deployment.progressOfUploading),
                            operations: [self.deployment.currentOperationNumber, self.deployment.operationsCounter]
                        }
                    });

                    self.deployment.uploadFile();
                }
            }
        );
    }

    uploadDirectory(input, output) {
        let self = this;

        this.connection.mkdir(
            output,
            true,
            function (err) {
                if (err) {
                    self.deployment.outputLog.push(err);
                    self.deployment.outputLog.push('- - -ERROR UPLOAD DIR - - -');
                    self.deployment.outputLog.push(output);
                    self.deployment.outputLog.push(err);
                    self.deployment.outputLog.push('- - - - - - - - - - - - - - ');

                    setTimeout(() => {
                        if(!self.softUploadErrors[input]) {
                            self.softUploadErrors[input] = 1;
                        } else {
                            self.softUploadErrors[input]++;
                        }

                        if(self.softUploadErrors[input] <= 5) {
                            self.uploadDirectory(input, output);
                        } else {
                            self.hardUploadErrors.push(input);

                            self.deployment.currentOperationNumber++;
                            self.deployment.outputLog.push('UPL HARD ERR ' + input + ' -> ' + output);
                            self.deployment.progressOfUploading += self.deployment.progressPerFile;

                            process.send({
                                type: 'web-contents',
                                message: 'app-uploading-progress',
                                value: {
                                    progress: 8 + Math.floor(self.deployment.progressOfUploading),
                                    operations: [self.deployment.currentOperationNumber, self.deployment.operationsCounter]
                                }
                            });

                            self.deployment.uploadFile();
                        }
                    }, 500);
                } else {
                    self.deployment.currentOperationNumber++;
                    self.deployment.outputLog.push('UPL ' + input + ' -> ' + output);
                    self.deployment.progressOfUploading += self.deployment.progressPerFile;

                    process.send({
                        type: 'web-contents',
                        message: 'app-uploading-progress',
                        value: {
                            progress: 8 + Math.floor(self.deployment.progressOfUploading),
                            operations: [self.deployment.currentOperationNumber, self.deployment.operationsCounter]
                        }
                    });

                    self.deployment.uploadFile();
                }
            }
        );
    }

    removeFile(input) {
        let self = this;

        this.connection.delete(
            input,
            function (err) {
                self.deployment.currentOperationNumber++;
                self.deployment.outputLog.push('DEL ' + input);

                if (err) {
                    self.deployment.outputLog.push(err);
                    self.deployment.outputLog.push('- - -ERROR REMOVE FILE - - -');
                    self.deployment.outputLog.push(input);
                    self.deployment.outputLog.push(err);
                    self.deployment.outputLog.push('- - - - - - - - - - - - - - ');
                }

                self.deployment.progressOfDeleting += self.deployment.progressPerFile;

                process.send({
                    type: 'web-contents',
                    message: 'app-uploading-progress',
                    value: {
                        progress: 40 + Math.floor(self.deployment.progressOfDeleting),
                        operations: [self.deployment.currentOperationNumber ,self.deployment.operationsCounter]
                    }
                });

                self.deployment.removeFile();
            }
        );
    }

    removeDirectory(input) {
        let self = this;

        this.connection.rmdir(
            input,
            true,
            function (err) {
                self.deployment.currentOperationNumber++;
                self.deployment.outputLog.push('DEL ' + input);

                if (err) {
                    self.deployment.outputLog.push(err);
                    self.deployment.outputLog.push('- - -ERROR REMOVE DIR - - -');
                    self.deployment.outputLog.push(input);
                    self.deployment.outputLog.push(err);
                    self.deployment.outputLog.push('- - - - - - - - - - - - - - ');
                }
                self.deployment.progressOfDeleting += self.deployment.progressPerFile;

                process.send({
                    type: 'web-contents',
                    message: 'app-uploading-progress',
                    value: {
                        progress: 8 + Math.floor(self.deployment.progressOfDeleting),
                        operations: [self.deployment.currentOperationNumber, self.deployment.operationsCounter]
                    }
                });

                self.deployment.removeFile();
            }
        );
    }

    async testConnection(app, deploymentConfig, siteName) {
        let client = new ftpClient();
        let waitForTimeout = true;
        let ftpPassword = deploymentConfig.password;
        let account = slug(siteName);
        let secureConnection = false;

        if(ftpPassword === 'publii ' + account) {
            ftpPassword = await passwordSafeStorage.getPassword('publii', account);
        }

        if(deploymentConfig.protocol !== 'ftp') {
            secureConnection = 'control';
        }

        let connectionParams = {
            host: deploymentConfig.server,
            port: deploymentConfig.port,
            user: deploymentConfig.username,
            password: ftpPassword,
            secure: secureConnection,
            secureOptions: {
                host: deploymentConfig.server,
                port: deploymentConfig.port,
                user: deploymentConfig.username,
                password: ftpPassword
            },
            connTimeout: 10000,
            pasvTimeout: 10000
        };

        let testFilePath = normalizePath(path.join(app.sitesDir, siteName, 'input', 'publii.test'));
        fs.writeFileSync(testFilePath, 'It is a test file. You can remove it.');
        client.connect(connectionParams);

        client.on('ready', () => {
            waitForTimeout = false;

            client.put(
                normalizePath(testFilePath),
                normalizePath(path.join(deploymentConfig.path, 'publii.test')),
                (err) => {   
                    if (err) {
                        app.mainWindow.webContents.send('app-deploy-test-write-error');

                        if (fs.existsSync(testFilePath)) {
                            fs.unlinkSync(testFilePath);
                        }

                        client.destroy();
                        return;   
                    }
                    
                    client.delete(
                        normalizePath(path.join(deploymentConfig.path, 'publii.test')),
                        (err) => {
                            if (err) {
                                app.mainWindow.webContents.send('app-deploy-test-write-error');
                                
                                if (fs.existsSync(testFilePath)) {
                                    fs.unlinkSync(testFilePath);
                                }

                                client.destroy();
                                return;
                            }

                            app.mainWindow.webContents.send('app-deploy-test-success');
                            
                            if (fs.existsSync(testFilePath)) {
                                fs.unlinkSync(testFilePath);
                            }

                            client.destroy();
                        }
                    );
                }
            );
        });

        if (fs.existsSync(testFilePath)) {
            fs.unlinkSync(testFilePath);
        }

        client.on('error', function(err) {
            if(waitForTimeout) {
                waitForTimeout = false;
                client.destroy();
                app.mainWindow.webContents.send('app-deploy-test-error');
            }
        });

        setTimeout(function() {
            if(waitForTimeout === true) {
                client.destroy();
                app.mainWindow.webContents.send('app-deploy-test-error');
            }
        }, 15000);
    }

    connectionDebugger(message) {
        if(message.indexOf("[connection] > 'PASS ") > -1) {
            message = '[connection] > PASS ******************************';
        }

        this.debugOutput.push(message);
    }

    saveConnectionDebugLog() {
        let logPath = path.join(this.deployment.appDir, 'logs', 'connection-debug-log.txt');
        let softUploadErrorsPath = path.join(this.deployment.appDir, 'logs', 'soft-upload-errors-log.txt');
        let hardUploadErrorsPath = path.join(this.deployment.appDir, 'logs', 'hard-upload-errors-log.txt');

        fs.writeFileSync(logPath, this.debugOutput.join("\n"));
        fs.writeFileSync(softUploadErrorsPath, JSON.stringify(this.softUploadErrors));
        fs.writeFileSync(hardUploadErrorsPath, JSON.stringify(this.hardUploadErrors));
    }
}

module.exports = FTP;
