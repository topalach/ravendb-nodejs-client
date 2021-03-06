const fs = require('fs');
const gulp = require('gulp');
const rmdir = require('rimraf');
const tssort = require('gulp-typescript-easysort');
const mocha = require('gulp-mocha');
const ts = require('gulp-typescript');
const transform = require('gulp-transform');
const concat = require('gulp-concat');
const uglify = require('gulp-uglify-harmony');
const args = require('./args');

const tsProject = ts.createProject('./tsconfig.json') 
const preamble = '/** RavenDB Client - (c) Hibernating Rhinos 2017 */';
const exportDefault = 'export default DocumentStore;';

const options = {
    src: './src',
    tests: './test',
    tmp: './.build',
    dest: './lib'
};

const allExceptions = () => fs
    .readFileSync(`${options.src}/Database/DatabaseExceptions.ts`)
    .toString().match(/class\s+([\w\d]+)\s*/g)
    .map((match) => match.replace(/class\s+/, ''));  

const getVersion = () => JSON
    .parse(fs
    .readFileSync('./package.json')
    .toString())
    .version;

gulp.task('clean', (next) => rmdir(options.tmp, next));

gulp.task('build:tests:args', ['clean'], () => gulp
    .src('./args.js', {
        base: __dirname
    })
    .pipe(gulp.dest(options.tmp))
);

gulp.task('build:tests', ['clean', 'build:tests:args'], () => gulp
    .src([
        options.tests + '/Test*.ts',
        options.tests + '/**/*Test.ts',
        options.src + '/[A-Z]*/**/*.ts'
    ], {
        base: __dirname
    })
    .pipe(transform(contents => contents
        .toString()
        .split('\n')        
        .map(line => line.replace(
            /"Raven\-Client\-Version": "[\w\d\-\.]+"/, 
            `"Raven-Client-Version": "${getVersion()}"`)
        )
        .join('\n')
    ))
    .pipe(ts({
        allowJs: true,
        target: 'ES6',
        module: 'commonjs',
        removeComments: true,
        lib: ["dom", "es7"]
    }))
    .pipe(gulp.dest(options.tmp))
);

gulp.task('run:tests', ['clean', 'build:tests:args', 'build:tests'], () => {
    let tests = args.test.map(
        (test) => `${options.tmp}/test/**/${test}Test.js`
    );

    let mochaOpts = {
        "timeout": 10000,
        "ravendb-host": args["ravendb-host"], 
        "ravendb-port": args["ravendb-port"]
    };

    if (args.test.includes('*') || (true !== args['no-fixtures'])) {
        tests.unshift(options.tmp + '/test/TestBase.js');
    }

    if (args["ravendb-certificate"]) {
        mochaOpts["ravendb-certificate"] = args["ravendb-certificate"];
    }

    if (args["report-xml"]) {
        mochaOpts["reporter"] = 'mocha-junit-reporter';
    }

    return gulp.src(tests)
        .pipe(mocha(mochaOpts))
        .on('error', () => process.exit(-1));
});

gulp.task('build:exports', ['clean'], () => gulp
    .src(options.src + '/ravendb-node.ts')
    .pipe(transform(contents => preamble + "\n"
        + contents
            .toString()
            .split('\n')
            .map(line => (line.startsWith('export') 
                || line.startsWith('} from'))
                ? line.replace(/ from.*;/, ';')
                : line
            )            
            .join('\n')
    ))
    .pipe(gulp.dest(options.tmp))
);

gulp.task('build:concat', ['clean'], () => gulp
    .src(`${options.src}/[A-Z]*/**/*.ts`)
    .pipe(tssort())
    .pipe(concat('ravendb-node.bundle.ts'))        
    .pipe(transform(contents => contents
        .toString()
        .split('\n')
        .filter(line => !line.startsWith('import'))
        .map(line => line.replace(/export /, ''))
        .map(line => line.replace(
            '<IRavenObject<typeof RavenException>><any>exceptions',
            `{ ${allExceptions().join(', ')} }`
        ))
        .map(line => line.replace(
            /"Raven\-Client\-Version": "[\w\d\-\.]+"/, 
            `"Raven-Client-Version": "${getVersion()}"`)
        )
        .join('\n')
        + "\n\n" + exportDefault + "\n"
    ))
    .pipe(gulp.dest(options.tmp))
);

gulp.task('build:bundle', ['clean', 'build:exports', 'build:concat'], () => gulp
    .src([
        options.tmp + '/ravendb-node.ts',
        options.tmp + '/ravendb-node.bundle.ts'
    ])
    .pipe(concat('ravendb-node.ts'))
    .pipe(gulp.dest(options.tmp))
);

gulp.task('build:compile', ['clean', 'build:exports', 'build:concat', 'build:bundle'], () => gulp
    .src(options.tmp + '/ravendb-node.ts')
    .pipe(tsProject())
    .pipe(gulp.dest(options.dest))
);

gulp.task('build:uglify', ['clean', 'build:exports', 'build:concat', 'build:bundle', 'build:compile'], () => gulp
    .src(options.dest + '/ravendb-node.js')
    .pipe(uglify({
        mangle: {
            toplevel: true
        },
        output: {
            preamble: preamble
        }
    }))
    .pipe(gulp.dest(options.dest))
);

gulp.task('test', ['clean', 'build:tests:args', 'build:tests', 'run:tests']);

gulp.task('bundle', ['clean', 'build:exports', 'build:concat', 'build:bundle', 'build:compile', 'build:uglify']);