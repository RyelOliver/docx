const BOLD = '\x1b[1m%s\x1b[0m';
const RED = '\x1b[31m%s\x1b[0m';
const GREEN = '\x1b[32m%s\x1b[0m';
const YELLOW = '\x1b[33m%s\x1b[0m';
const TEAL = '\x1b[36m%s\x1b[0m';

const INFO = 'info';
const WARN = 'warn';
const ERROR = 'error';

function print (message, { type = INFO, style } = {}) {
    return style ?
        console[type](style, message) :
        console[type](message);
}
print.TYPE = {
    INFO,
    WARN,
    ERROR,
};
print.STYLE = {
    BOLD,
    RED,
    GREEN,
    YELLOW,
    TEAL,
};

function isNil (value) {
    return value == null;
}

function hasLeadingOrTrailingWhiteSpace (value) {
    return value !== value.trim();
}

module.exports = {
    print,
    isNil,
    hasLeadingOrTrailingWhiteSpace,
};