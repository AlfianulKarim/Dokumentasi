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
            // Perlu untuk Netlify/AWS Lambda, karena body sudah di-decode
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

        // Tulis body yang sudah di-decode ke busboy
        bb.write(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
        bb.end();
    });
};


exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { fields, files } = await parseMultipartForm(event);
        
        // 1. Mengelompokkan data responden
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

        const F4 = [595.28, 935.43]; // Ukuran F4 dalam poin (210mm x 330mm)
        const doc = new PDFDocument({ size: F4, margin: 50 });
        const passThrough = new PassThrough();
        doc.pipe(passThrough);

        // Header
        doc.fontSize(14).font('Helvetica-Bold').text('DOKUMENTASI KEGIATAN WAWANCARA', { align: 'center' })
            .moveDown(0.5)
            .text('KAJIAN KELAYAKAN PENDIRIAN KAMPUS DAN PSDKU', { align: 'center' })
            .moveDown(0.5)
            .text('DI KABUPATEN BLORA', { align: 'center' })
            .moveDown()
            .moveTo(50, doc.y).lineTo(550, doc.y).stroke()
            .moveDown();

        // Info Enumerator
        const [nama, nik] = (fields.enumerator || ' - ').split(' - ');
        const tanggal = new Date(fields.tanggal + 'T00:00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
        
        doc.fontSize(10).font('Helvetica');
        const initialY = doc.y;
        const labelX = 50;
        const valueX = 170; // Posisi X untuk nilai setelah titik dua

        doc.text('Nama Enumerator', labelX, initialY);
        doc.text(`: ${nama}`, valueX, initialY);

        doc.text('NIK', labelX, initialY + 15);
        doc.text(`: ${nik}`, valueX, initialY + 15);

        doc.text('Tanggal Wawancara', labelX, initialY + 30);
        doc.text(`: ${tanggal}`, valueX, initialY + 30);

        doc.y = initialY + 45; 
        doc.moveDown(2);


        // 3. Menambahkan data setiap responden ke PDF
        for (let i = 0; i < allResponden.length; i++) {
            const data = allResponden[i];
            
            // PERBAIKAN: Hitung estimasi tinggi secara dinamis
            const photoWidth = 230;
            let maxHeight = 180; // Tinggi default jika tidak ada gambar
            
            let imgSebelumBuffer, imgSesudahBuffer;
            if (data.sebelum && data.sebelum.content.length > 0) {
                 imgSebelumBuffer = await sharp(data.sebelum.content).resize({ width: 800 }).jpeg({ quality: 80 }).toBuffer();
                 const metadata = await sharp(imgSebelumBuffer).metadata();
                 const scaledHeight = (metadata.height / metadata.width) * photoWidth;
                 if (scaledHeight > maxHeight) maxHeight = scaledHeight;
            }
            if (data.sesudah && data.sesudah.content.length > 0) {
                 imgSesudahBuffer = await sharp(data.sesudah.content).resize({ width: 800 }).jpeg({ quality: 80 }).toBuffer();
                 const metadata = await sharp(imgSesudahBuffer).metadata();
                 const scaledHeight = (metadata.height / metadata.width) * photoWidth;
                 if (scaledHeight > maxHeight) maxHeight = scaledHeight;
            }
            
            const sectionHeight = maxHeight + 90; // Tinggi gambar + teks + margin
            if (doc.y + sectionHeight > doc.page.height - 50) { 
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
             
            // Gambar 'sebelum'
            if (imgSebelumBuffer) {
                try {
                    doc.image(imgSebelumBuffer, 50, photoY, { width: photoWidth });
                } catch (e) {
                     doc.font('Helvetica').text('Gagal memproses gambar sebelum.', 50, photoY);
                }
            }

            // Gambar 'sesudah'
            if (imgSesudahBuffer) {
                 try {
                    doc.image(imgSesudahBuffer, 320, photoY, { width: photoWidth });
                } catch (e) {
                     doc.font('Helvetica').text('Gagal memproses gambar sesudah.', 320, photoY);
                }
            }
            
            // Pindahkan posisi teks keterangan ke bawah kotak foto
            const captionY = photoY + maxHeight + 5;
            doc.font('Helvetica-Bold').fontSize(8);
            doc.text('FOTO SEBELUM WAWANCARA', 50, captionY, { width: photoWidth, align: 'center' });
            doc.text('FOTO SESUDAH WAWANCARA', 320, captionY, { width: photoWidth, align: 'center' });
            
            // Pindahkan cursor ke bawah blok foto dan keterangannya
            doc.y = captionY + 20;
        }

        doc.end();
        
        // 4. Mengirim PDF kembali ke browser
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
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: `Terjadi kesalahan di server: ${error.message}` }),
        };
    }
