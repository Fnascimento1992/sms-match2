const mongoose = require('mongoose')
const Schema = mongoose.Schema

const smsSchema = new Schema({
    command: String,
    to: { type: String, default: null },
    esmeId: { type: String, default: null },
    vhost: { type: String, default: null },
    address_range: { type: String, default: null },

    messageId: { type: String, default: null },
    message: { type: String, default: null },
    status: { type: String, default: null },
    dispatchDate: { type: Date, default: null },
    smsFile: {
        file: { type: String, default: null },
        tplSMS: { type: String, default: null }
    },

    bufferData: [Number],
    command_length: { type: Number, default: 0 },
    command_id: { type: Number, default: 0 },
    command_status: { type: Number, default: 0 },
    sequence_number: { type: Number, default: 0 },
    source_addr: { type: String, default: null },
    dest_addr_ton: { type: Number, default: 0 },
    dest_addr_npi: { type: Number, default: 0 },
    destination_addr: { type: String, default: null },
    short_message: {
        message: { type: String, default: null }
    },
    receiptDate: Date,
    docType: { type: String, required: true, enum: ['disparo', 'retorno'] }
})

const SMS = mongoose.model('sms-receipts', smsSchema)

module.exports = SMS
