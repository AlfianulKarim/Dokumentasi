const busboy = require('busboy');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const { PassThrough } = require('stream');

// Helper untuk membaca stream ke buffer
const streamToBuffer = (stream) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
};

// Helper untuk mem-parsing form data
const parseMultipartForm = (event) => {
    return new Promise((resolve) => {
        const fields = {};
        const files = {};

        const bb = busboy({
            headers: event.headers,
            defParamCharset: 'utf8' 
        });

        bb.on('file', async (name, stream, info) => {
            const { filename, encoding, mimeType } = info;
            const buffer = await streamToBuffer(stream);
            files[name] = {
                filename,
                encoding,
                mimeType,
                content: buffer,
            };
        });

        bb.on('field', (name, value) => {
            fields[name] = value;
        });

        bb.on('close', () => {
            resolve({ fields, files });
        });
        
        bb.on('error', (err) => {
            console.error('Busboy error:', err);
        });

        bb.write(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
        bb.end();
    });
};


exports.handler = async (event) => {
    console.log('Function generate-pdf invoked.');

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        console.log('Starting form parsing...');
        const { fields, files } = await parseMultipartForm(event);
        console.log('Form parsing complete. Fields:', Object.keys(fields).length, 'Files:', Object.keys(files).length);
        
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
                respondenData[id][type] = files[key];
            }
        }
        const allResponden = Object.values(respondenData);
        console.log(`Grouped ${allResponden.length} respondents.`);

        const F4 = [595.28, 935.43];
        const doc = new PDFDocument({ size: F4, margin: 50 });
        const passThrough = new PassThrough();
        doc.pipe(passThrough);
        console.log('PDF document initialized.');

        // Header
        doc.fontSize(14).font('Helvetica-Bold').text('DOKUMENTASI KEGIATAN WAWANCARA', { align: 'center' })
            .moveDown(0.5).text('KAJIAN KELAYAKAN PENDIRIAN KAMPUS DAN PSDKU', { align: 'center' })
            .moveDown(0.5).text('DI KABUPATEN BLORA', { align: 'center' })
            .moveDown().moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown();

        // Info Enumerator
        const [nama, nik] = (fields.enumerator || ' - ').split(' - ');
        const tanggal = new Date(fields.tanggal + 'T00:00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
        
        doc.fontSize(10).font('Helvetica');
        const initialY = doc.y;
        const labelX = 50;
        const valueX = 170;

        doc.text('Nama Enumerator', labelX, initialY);
        doc.text(`: ${nama}`, valueX, initialY);
        doc.text('NIK', labelX, initialY + 15);
        doc.text(`: ${nik}`, valueX, initialY + 15);
        doc.text('Tanggal Wawancara', labelX, initialY + 30);
        doc.text(`: ${tanggal}`, valueX, initialY + 30);

        doc.y = initialY + 45; 
        doc.moveDown(2);
        console.log('Header and enumerator info added.');

        // 3. Menambahkan data setiap responden ke PDF
        for (let i = 0; i < allResponden.length; i++) {
            let data = allResponden[i];
            console.log(`--- Processing respondent #${i + 1} ---`);
            
            const photoWidth = 230;
            let maxHeight = 180;
            let imgSebelumBuffer, imgSesudahBuffer;

            // Proses gambar 'sebelum'
            if (data.sebelum && data.sebelum.content && data.sebelum.content.length > 0) {
                 try {
                    console.log(`Responden #${i + 1}: Processing 'sebelum' image (${(data.sebelum.content.length / 1024).toFixed(1)} KB)`);
                    imgSebelumBuffer = await sharp(data.sebelum.content).resize({ width: 600 }).jpeg({ quality: 80 }).toBuffer(); // Mengurangi resolusi
                    const metadata = await sharp(imgSebelumBuffer).metadata();
                    const scaledHeight = (metadata.height / metadata.width) * photoWidth;
                    if (scaledHeight > maxHeight) maxHeight = scaledHeight;
                    console.log(`Responden #${i + 1}: 'sebelum' image processed.`);
                 } catch(e){ console.error(`Responden #${i + 1}: Error processing 'sebelum' image:`, e); }
            } else {
                 console.log(`Responden #${i + 1}: No 'sebelum' image found.`);
            }

            // Proses gambar 'sesudah'
            if (data.sesudah && data.sesudah.content && data.sesudah.content.length > 0) {
                 try {
                    console.log(`Responden #${i + 1}: Processing 'sesudah' image (${(data.sesudah.content.length / 1024).toFixed(1)} KB)`);
                    imgSesudahBuffer = await sharp(data.sesudah.content).resize({ width: 600 }).jpeg({ quality: 80 }).toBuffer(); // Mengurangi resolusi
                    const metadata = await sharp(imgSesudahBuffer).metadata();
                    const scaledHeight = (metadata.height / metadata.width) * photoWidth;
                    if (scaledHeight > maxHeight) maxHeight = scaledHeight;
                    console.log(`Responden #${i + 1}: 'sesudah' image processed.`);
                 } catch(e){ console.error(`Responden #${i + 1}: Error processing 'sesudah' image:`, e); }
            } else {
                console.log(`Responden #${i + 1}: No 'sesudah' image found.`);
            }
            
            // Hapus referensi ke buffer mentah secepat mungkin
            if (data.sebelum) data.sebelum.content = null;
            if (data.sesudah) data.sesudah.content = null;

            const sectionHeight = maxHeight + 90;
            console.log(`Responden #${i + 1}: Calculated max height = ${maxHeight.toFixed(1)}, section height = ${sectionHeight.toFixed(1)}`);
            if (doc.y + sectionHeight > doc.page.height - 50) { 
                console.log(`Responden #${i + 1}: Not enough space, adding new page.`);
                doc.addPage();
            }

            // Garis pemisah
            doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown();

            // Info Responden
            doc.fontSize(12).font('Helvetica-Bold').text(`RESPONDEN KE-${i + 1}`, { underline: true });
            doc.fontSize(9).font('Helvetica');
            doc.text(`Kategori: ${data.kategori || 'N/A'}`);
            doc.text(`Lokasi: ${data.lokasi || 'N/A'}`).moveDown();

            const photoY = doc.y;
             
            if (imgSebelumBuffer) {
                try {
                    doc.image(imgSebelumBuffer, 50, photoY, { width: photoWidth });
                } catch (e) {
                     console.error(`Responden #${i + 1}: Error adding 'sebelum' image to PDF:`, e);
                     doc.font('Helvetica').text('Gagal memuat gambar sebelum.', 50, photoY);
                }
            }
            if (imgSesudahBuffer) {
                 try {
                    doc.image(imgSesudahBuffer, 320, photoY, { width: photoWidth });
                } catch (e) {
                     console.error(`Responden #${i + 1}: Error adding 'sesudah' image to PDF:`, e);
                     doc.font('Helvetica').text('Gagal memuat gambar sesudah.', 320, photoY);
                }
            }
            
            const captionY = photoY + maxHeight + 5;
            doc.font('Helvetica-Bold').fontSize(8);
            doc.text('FOTO SEBELUM WAWANCARA', 50, captionY, { width: photoWidth, align: 'center' });
            doc.text('FOTO SESUDAH WAWANCARA', 320, captionY, { width: photoWidth, align: 'center' });
            
            doc.y = captionY + 20;

            // PERBAIKAN: Memaksa garbage collection
            if (global.gc) {
                console.log(`Responden #${i+1}: Triggering garbage collection.`);
                global.gc();
            } else {
                console.log(`Responden #${i+1}: Garbage collection not exposed.`);
            }
            console.log(`--- Finished respondent #${i + 1} ---`);
        }

        console.log('Finalizing PDF and sending response...');
        doc.end();
        
        const pdfBuffer = await streamToBuffer(passThrough);
        const fileName = `Dokumentasi Wawancara - ${nama}.pdf`;

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
            body: JSON.stringify({ message: `Terjadi kesalahan fatal di server: ${error.message}` }),
        };
    }
};
