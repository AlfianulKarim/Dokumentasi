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


        // 2. Membuat dokumen PDF
        const doc = new PDFDocument({ size: 'A4', margin: 50 });
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
        doc.text(`Nama Enumerator    : ${nama}`);
        doc.text(`NIK                 : ${nik}`);
        doc.text(`Tanggal Wawancara : ${tanggal}`).moveDown(2);


        // 3. Menambahkan data setiap responden ke PDF
        for (let i = 0; i < allResponden.length; i++) {
            const data = allResponden[i];
            
            // Periksa apakah halaman perlu ditambah
            // Estimasi tinggi section: 250pt, margin bawah 50pt
            if (doc.y + 250 > 792 - 50) { 
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
            const photoWidth = 230;

            // Proses dan tambahkan gambar 'sebelum'
            if (data.sebelum && data.sebelum.content.length > 0) {
                try {
                    const processedImage = await sharp(data.sebelum.content)
                        .resize({ width: 800 }) // Kecilkan ukuran untuk efisiensi
                        .jpeg({ quality: 80 })
                        .toBuffer();
                    doc.image(processedImage, 50, photoY, { width: photoWidth });
                    doc.font('Helvetica-Bold').text('FOTO SEBELUM WAWANCARA', 50, photoY + 165, { width: photoWidth, align: 'center' });
                } catch (e) {
                     doc.font('Helvetica').text('Gagal memproses gambar sebelum.', 50, photoY);
                }
            }

            // Proses dan tambahkan gambar 'sesudah'
            if (data.sesudah && data.sesudah.content.length > 0) {
                 try {
                    const processedImage = await sharp(data.sesudah.content)
                        .resize({ width: 800 })
                        .jpeg({ quality: 80 })
                        .toBuffer();
                    doc.image(processedImage, 320, photoY, { width: photoWidth });
                    doc.font('Helvetica-Bold').text('FOTO SESUDAH WAWANCARA', 320, photoY + 165, { width: photoWidth, align: 'center' });
                } catch (e) {
                     doc.font('Helvetica').text('Gagal memproses gambar sesudah.', 320, photoY);
                }
            }
            doc.y = photoY + 190; // Pindahkan cursor ke bawah gambar
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
};
