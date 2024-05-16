const mongoose = require('mongoose')
require('dotenv').config()

const listDatabases = async () => {
    let client
    try {
        client = await mongoose.connect(`${process.env.DATABASE_URL_MONGO}/admin`)
        const admin = client.connection.getClient().db().admin()

        const { databases } = await admin.listDatabases()
        return databases.map(db => db.name).filter(name => !['admin', 'local', 'config', 'management'].includes(name))
    } catch (error) {
        console.error('Erro ao listar os bancos de dados\n', error)
        throw error
    } finally {
        if (client) {
            mongoose.disconnect()
        }
    }
}

module.exports = listDatabases
