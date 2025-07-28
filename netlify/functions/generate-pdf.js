// FILE: netlify/functions/generate-pdf.js
// Ganti seluruh isi file lama Anda dengan kode di bawah ini.
const busboy = require('busboy');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const {
    PassThrough
} = require('stream');

// Helper untuk membaca stream ke buffer
const streamToBuffer = (stream) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
};

// --- PERBAIKAN: Fungsi parsing yang lebih efisien memori & lebih cepat ---
const parseAndProcessForm = (event) => {
    return new Promise((resolve, reject) => {
        const fields = {};
        const files = {};
        const fileProcessingPromises = [];
        const functionStartTime = Date.now();

        const bb = busboy({
            headers: event.headers,
            defParamCharset: 'utf8'
        });

        bb.on('file', (name, stream, info) => {
            const processPromise = async () => {
                try {
                    const fileStartTime = Date.now();
                    console.log(`[T+${(fileStartTime - functionStartTime) / 1000}s] Receiving file stream: ${name}`);
                    const rawBuffer = await streamToBuffer(stream);

                    // --- OPTIMISASI UNTUK KECEPATAN ---
                    const processedBuffer = await sharp(rawBuffer)
                        .resize({
                            width: 720, // Mengurangi resolusi untuk proses lebih cepat
                            fit: 'inside',
                            withoutEnlargement: true
                        })
                        .jpeg({
                            quality: 80, // Mengurangi kualitas sedikit untuk file lebih kecil & cepat
                            progressive: true
                        })
                        .toBuffer();

                    files[name] = {
                        filename: info.filename,
                        mimeType: 'image/jpeg',
                        content: processedBuffer,
                    };
                    const fileEndTime = Date.now();
                    console.log(`[T+${(fileEndTime - functionStartTime) / 1000}s] File ${name} processed in ${(fileEndTime - fileStartTime)}ms. Size: ${(rawBuffer.length / 1024).toFixed(1)}KB -> ${(processedBuffer.length / 1024).toFixed(1)}KB`);
                } catch (err) {
                    console.error(`Error processing file ${name}:`, err);
                }
            };
            fileProcessingPromises.push(processPromise());
        });

        bb.on('field', (name, value) => {
            fields[name] = value;
        });

        bb.on('close', async () => {
            try {
                await Promise.all(fileProcessingPromises);
                console.log(`[T+${(Date.now() - functionStartTime) / 1000}s] All file streams processed.`);
                resolve({
                    fields,
                    files
                });
            } catch (err) {
                reject(err);
            }
        });

        bb.on('error', (err) => {
            console.error('Busboy error:', err);
            reject(err);
        });

        bb.write(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
        bb.end();
    });
};


exports.handler = async (event) => {
    const handlerStartTime = Date.now();
    console.log(`[T+0s] Function generate-pdf invoked.`);

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: 'Method Not Allowed'
        };
    }

    try {
        const {
            fields,
            files
        } = await parseAndProcessForm(event);
        console.log(`[T+${(Date.now() - handlerStartTime) / 1000}s] Form parsing and processing complete.`);

        const respondenData = {};
        for (const key in fields) {
            if (key.includes('_')) {
                const [type, id] = key.split('_');
                if (!respondenData[id]) respondenData[id] = {};
                respondenData[id][type] = fields[key];
            }
        }
        for (const key in files) {
            if (key.includes('_')) {
                const [type, id] = key.split('_');
                if (!respondenData[id]) respondenData[id] = {};
                respondenData[id][type] = files[key].content;
            }
        }
        const allResponden = Object.values(respondenData);
        console.log(`[T+${(Date.now() - handlerStartTime) / 1000}s] Grouped ${allResponden.length} respondents.`);

        const F4 = [595.28, 935.43];
        const doc = new PDFDocument({
            size: F4,
            margin: 50,
            bufferPages: true // Penting untuk performa dengan banyak halaman
        });
        const passThrough = new PassThrough();
        doc.pipe(passThrough);

        // Header
        doc.fontSize(14).font('Helvetica-Bold').text('DOKUMENTASI KEGIATAN WAWANCARA', {
            align: 'center'
        }).moveDown(0.5).text('KAJIAN KELAYAKAN PENDIRIAN KAMPUS DAN PSDKU', {
            align: 'center'
        }).moveDown(0.5).text('DI KABUPATEN BLORA', {
            align: 'center'
        }).moveDown().moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown();

        // Info Enumerator
        const [nama, nik] = (fields.enumerator || ' - ').split(' - ');
        const tanggal = new Date(fields.tanggal + 'T00:00:00').toLocaleDateString('id-ID', {
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });
        const labelX = 50;
        const valueX = 170;
        let currentY = doc.y;
        doc.fontSize(10).font('Helvetica');
        doc.text('Nama Enumerator', labelX, currentY);
        doc.text(`: ${nama}`, valueX, currentY);
        currentY += 15;
        doc.text('NIK', labelX, currentY);
        doc.text(`: ${nik}`, valueX, currentY);
        currentY += 15;
        doc.text('Tanggal Wawancara', labelX, currentY);
        doc.text(`: ${tanggal}`, valueX, currentY);
        doc.y = currentY + 15;
        doc.moveDown(2);
        console.log(`[T+${(Date.now() - handlerStartTime) / 1000}s] PDF Header created.`);

        // Menambahkan data setiap responden ke PDF
        for (let i = 0; i < allResponden.length; i++) {
            const data = allResponden[i];
            const photoWidth = 230;
            let maxHeight = 180;
            let imgSebelumBuffer = data.sebelum;
            let imgSesudahBuffer = data.sesudah;

            if (imgSebelumBuffer) {
                const metadata = await sharp(imgSebelumBuffer).metadata();
                const scaledHeight = (metadata.height / metadata.width) * photoWidth;
                if (scaledHeight > maxHeight) maxHeight = scaledHeight;
            }
            if (imgSesudahBuffer) {
                const metadata = await sharp(imgSesudahBuffer).metadata();
                const scaledHeight = (metadata.height / metadata.width) * photoWidth;
                if (scaledHeight > maxHeight) maxHeight = scaledHeight;
            }

            const sectionHeight = maxHeight + 90;
            if (doc.y + sectionHeight > doc.page.height - 50) {
                console.log(`Adding new page for respondent ${i + 1}`);
                doc.addPage();
            }

            doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown();
            doc.fontSize(12).font('Helvetica-Bold').text(`RESPONDEN KE-${i + 1}`, {
                underline: true
            });
            doc.fontSize(9).font('Helvetica');
            doc.text(`Kategori: ${data.kategori || 'N/A'}`);
            doc.text(`Lokasi: ${data.lokasi || 'N/A'}`).moveDown();

            const photoY = doc.y;
            if (imgSebelumBuffer) {
                doc.image(imgSebelumBuffer, 50, photoY, {
                    width: photoWidth,
                    align: 'center',
                    valign: 'center'
                });
            }
            if (imgSesudahBuffer) {
                doc.image(imgSesudahBuffer, 320, photoY, {
                    width: photoWidth,
                    align: 'center',
                    valign: 'center'
                });
            }

            const captionY = photoY + maxHeight + 5;
            doc.font('Helvetica-Bold').fontSize(8);
            doc.text('FOTO SEBELUM WAWANCARA', 50, captionY, {
                width: photoWidth,
                align: 'center'
            });
            doc.text('FOTO SESUDAH WAWANCARA', 320, captionY, {
                width: photoWidth,
                align: 'center'
            });
            doc.y = captionY + 20;
            console.log(`[T+${(Date.now() - handlerStartTime) / 1000}s] Respondent ${i + 1} added to PDF.`);
        }

        doc.end();

        const pdfBuffer = await streamToBuffer(passThrough);
        const fileName = `Dokumentasi Wawancara - ${nama}.pdf`;
        console.log(`[T+${(Date.now() - handlerStartTime) / 1000}s] PDF generated, size: ${(pdfBuffer.length / 1024).toFixed(1)}KB. Sending response.`);

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="${fileName}"`,
            },
            body: pdfBuffer.toString('base64'),
            isBase64Encoded: true,
        };

    } catch (error) {
        console.error('!!!--- FATAL SERVER ERROR ---!!!');
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        return {
            statusCode: 500,
            body: JSON.stringify({
                message: `Terjadi kesalahan fatal di server: ${error.message}`
            }),
        };
    }
};
