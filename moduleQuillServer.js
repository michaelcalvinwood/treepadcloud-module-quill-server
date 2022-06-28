const { S3, ListObjectsV2Command , PutObjectCommand, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const redisPackage = require('redis');
const { v4: uuidv4 } = require('uuid');
const HTMLtoDOCX = require('html-to-docx');
const fs = require('fs');
const fsp = require('fs').promises;
const pandoc = require('node-pandoc');
const { Blob } = require("buffer");
const monitor = require('./utils/eventMonitor');
const serializerr = require('serializerr');

require('dotenv').config();

var serverOptions = {
  key: fs.readFileSync(process.env.SSL_KEY_FILE),
  cert: fs.readFileSync(process.env.SSL_CERT_FILE)
};

var app = require('https').createServer(serverOptions);

const io = require('socket.io')(app, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    maxHttpBufferSize: 1e8
});
app.listen(process.env.QUILL_SERVER_PORT);


const redis = redisPackage.createClient({
    socket: {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT
    }
});
exports.redisClient = redis;

// create an S3 client
const options = {
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    credentials: {
      accessKeyId: process.env.S3_KEY,
      secretAccessKey: process.env.S3_SECRET
    }
}


const s3Client = new S3(options);

// function for getting signed put urls

const Bucket = process.env.S3_BUCKET;
const ContentType = 'image';
const expiresIn = 900;

const getPutSignedUrl = async (Key) => {
    const bucketParams = {Bucket, Key, ContentType};
  
    try {
      const url = await getSignedUrl(s3Client, new PutObjectCommand({Bucket, Key, ContentType}), { expiresIn }); 
      return url;
    } catch (err) {
      console.log("Error getPutSignedUrl", err);
      return false;
    }
};

// upload local file to S3

const upload = async (fileName, documentId, extension) => {
    const data = await fsp.readFile(fileName);
    let contentType = '';

    switch (extension.toLowerCase()) {
      case '.docx':
          contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          break;
      case '.pdf':
          contentType = 'application/pdf'
          break;

    }

    const bucketParams = {
        Bucket: process.env.S3_BUCKET,
        Key: `${documentId}/${documentId}${extension}`,
        Body: data,
        ACL: 'public-read',
        'Content-Type': contentType
      };
    
      try {
        const data = await s3Client.send(new PutObjectCommand(bucketParams));
        const link = `https://${process.env.S3_BUCKET}.${process.env.S3_ENDPOINT_DOMAIN}/${bucketParams.Key}`;
        return link;
      } catch (err) {
        console.log("Error", err);
        return '';
      }
        
};

// erase all S3 files in directory

const eraseS3Contents = async (folder) => {
    const listParams = {
        Bucket: process.env.S3_BUCKET,
        Prefix: `${folder}/`
    };

    const listedObjects = await s3Client.send(new ListObjectsV2Command(listParams));

    if (!listedObjects.Contents) return;
    if (listedObjects.Contents.length === 0) return;

    const deleteParams = {
        Bucket: process.env.S3_BUCKET,
        Delete: { Objects: [] }
    };

    listedObjects.Contents.forEach(({ Key }) => {
        deleteParams.Delete.Objects.push({ Key });
    });

    await s3Client.send(new DeleteObjectsCommand(deleteParams));

    if (listedObjects.IsTruncated) await eraseS3Contents(folder);
}

// connect to redis server  
redis.on('connect', async function() {
    console.log('Redis Connected');
});

redis.connect();

// const Document = require('./Document');
// const { createSocket } = require("dgram");
const defaultValue = '';

const unjoinOtherDocuments = socket => {
    const curRooms = socket.rooms;
    monitor.events(io, socket, ['on'], {on: 'moduleQuillServer|getInitialDocument', curRooms});
        
    for (let i = 0; i < curRooms.length; ++i) {
        if (curRooms[i] !== socket.id) socket.leave(curRooms[i]);
    }

    const roomsAfter = socket.rooms;
    monitor.events(io, socket, ['on'], {on: 'moduleQuillServer|getInitialDocument', roomsAfter});
}

io.on("connection", socket => {

    socket.on('getInitialDocument', async (documentId, token = null, permissions = []) => {
        try {
            monitor.events(io, socket, ['on'], {on: 'moduleQuillServer|getInitialDocument', documentId, token, permissions});
        
            let deltas = await redis.lRange(documentId, 0, -1);
    
            unjoinOtherDocuments(socket);

            // join current document
            socket.join(documentId);
    
            monitor.events(io, socket, ['emit'], {emit: 'moduleQuillServer|getInitialDocument', deltas, documentId});
            
            io.to(socket.id).emit('getInitialDocument', deltas, documentId);
        } catch (e) {
            console.error (e);
            monitor.events(io, socket, ['serr'], {serr: serializerr(e)})
        }
    })

    socket.on('newDelta', async (documentId, delta, expectedIndex, token = null, permissions = []) => {

        const actualIndex = await redis.rPush(documentId, JSON.stringify(delta));

        io.to(documentId).emit("newDelta", delta, actualIndex+1, socket.id);
        
        if (actualIndex === expectedIndex) return;

        let deltas = await redis.lRange(documentId, 0, -1);
        io.to(socket.id).emit('getInitialDocument', deltas);
    });

    socket.on('disconnect', () => {
    })
    
    socket.on('downloadWord', async (src, documentId) => {
      const outFile = `/var/www/html-to-docx.appgalleria.com/${documentId}.docx`;
        args = `-f html -t docx -o ${outFile}`;
        
        callback = async function (err, result) {
            if (err) {
                console.error('Oh Nos: ',err);
                io.to(socket.id).emit('downloadWord', '');
                return;
            } else {
                const link = await upload(outFile, documentId, '.docx');
                io.to(socket.id).emit('downloadWord', link);    
            }
          };
           
          // Call pandoc
          pandoc(src, args, callback);
    })

    socket.on('downloadPdf', async (src, documentId) => {
      const outFile = `/var/www/html-to-docx.appgalleria.com/${documentId}.pdf`;
        args = `-f html -t pdf -o ${outFile}`;
        
        callback = async function (err, result) {
            if (err) {
                console.error('Oh Nos: ',err);
                io.to(socket.id).emit('downloadPdf', '');
                return;
            } else {
                const link = await upload(outFile, documentId, '.pdf');
                io.to(socket.id).emit('downloadPdf', link);
    
            }

          };
           
          // Call pandoc
          pandoc(src, args, callback);
    })

    socket.on('get-upload-url', async (signatureData, documentId) => {
        let result = [];
        for (let i = 0; i < signatureData.length; ++i) {
            const fileName = `${documentId}/${uuidv4()}.${signatureData[i].extension}`;
            const url = await getPutSignedUrl(fileName);
            result.push({
                path: signatureData[i].path,
                fileName,
                url
            })
        }
        io.to(socket.id).emit('get-upload-url', result);
    });

    socket.on('cleanDocument', async documentId => {
      await eraseS3Contents(documentId);
      await redis.del(documentId);
      io.in(documentId).emit('getInitialDocument', []);
    });
});
