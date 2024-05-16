module.exports = {
    apps: [
        {
            name: 'malaquita',
            script: './src/app.js',
            watch: true,
            exec_mode: 'cluster',
            out_file: '/dev/null',
            error_file: '/dev/null',
            instances: 1
        }
    ]
}
