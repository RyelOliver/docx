const { print, isNil, hasLeadingOrTrailingWhiteSpace } = require('../Utility');
const { TYPE, STYLE } = print;
const Zip = require('../Zip');
const XML = require('../XML');
const { within } = require('../DOM');

const DEFAULT_NS = [
    'xml',
    'xmlns',
];

let _verbose = false;

function ValidationError ({ type = TYPE.ERROR, description, fileName, lineNumber, columnNumber }) {
    if (!description)
        throw Error('A description is required for a validation error.');
    return { type, description, fileName, lineNumber, columnNumber };
}

async function validateXml (zip) {
    if (_verbose)
        log({ type: TYPE.INFO, description: 'Validating XML...' });

    const errors = [];

    const files = zip.files
        .filter(fileName => fileName.match(/(\.xml|\.rels)$/))
        .map(async fileName => {
            const xml = await zip.read(fileName);
            return [ fileName, XML.parse(XML.format(xml)) ];
        });

    const documents = await Promise.all(files);

    documents.forEach(([ fileName, document ]) => {
        within(document).getAll('//*')
            .forEach(node => {
                Array.from(node.attributes)
                    .map(({ name, value, lineNumber, columnNumber }) => ({ name, value, lineNumber, columnNumber }))
                    .filter(({ name }) => name.indexOf(':') >= 0)
                    .forEach(({ name, lineNumber, columnNumber }) => {
                        const nameSpace = name.split(':')[0];
                        if (!DEFAULT_NS.includes(nameSpace) && !node.lookupNamespaceURI(nameSpace))
                            errors.push(ValidationError({ description: `"${nameSpace}" is an undeclared prefix.`, fileName, lineNumber, columnNumber }));
                    });
            });
    });

    return errors;
}

async function validateContentTypes (zip) {
    if (_verbose)
        log({ type: TYPE.INFO, description: 'Validating [Content_Types].xml...' });

    const errors = [];

    const fileName = zip.files.find(fileName => fileName === '[Content_Types].xml');

    if (!fileName) {
        errors.push(ValidationError({ description: '[Content_Types].xml is required.', fileName: '[Content_Types].xml' }));
    } else {
        const xml = await zip.read(fileName);
        const document = XML.parse(XML.format(xml));

        const overrides = within(document).getAll('/Types/Override');
        const missingPartNames = overrides.filter(override => {
            let partName = override.getAttribute('PartName');

            if (partName.match(/^\/(.*)/))
                partName = partName.match(/^\/(.*)/)[1];

            return !zip.files.includes(partName);
        });

        missingPartNames
            .forEach(partName => {
                const { lineNumber, columnNumber } = partName;
                errors.push(ValidationError({ description: '<Override/> requires a PartName attribute that references a file.', fileName, lineNumber, columnNumber }));
            });
    }

    return errors;
}

async function validateDocProps (zip) {
    if (_verbose)
        log({ type: TYPE.INFO, description: 'Validating docProps...' });

    const errors = [];

    const docProps = [
        { fileName: 'docProps/core.xml', required: true },
        { fileName: 'docProps/app.xml' },
        { fileName: 'docProps/custom.xml' },
    ];

    const promises = docProps.map(async ({ fileName, required }) => {
        if (zip.files.includes(fileName)) {
            const xml = await zip.read(fileName);
            const document = XML.parse(XML.format(xml));

            if (fileName === 'docProps/core.xml') {
                [
                    'dc:title',
                    'dc:creator',
                    'lastModifiedBy',
                    'revision',
                ].forEach(property => {
                    const title = within(document).get(`/coreProperties/${property}`);
                    if (!title)
                        errors.push(ValidationError({ type: TYPE.WARNING, description: `<${property}/> is missing.`, fileName }));
                });
            } else if (fileName === 'docProps/custom.xml') {
                const properties = within(document).getAll('/Properties/property');
                const pids = [];
                properties.forEach(property => {
                    const { lineNumber, columnNumber } = property;
                    const pid = property.getAttribute('pid');
                    if (!parseInt(pid) || parseInt(pid) < 2)
                        errors.push(ValidationError({ description: `<property pid="${pid}"/> is invalid.`, fileName, lineNumber, columnNumber }));
                    if (pids.includes(pid))
                        errors.push(ValidationError({ description: `<property pid="${pid}"/> is not unique.`, fileName, lineNumber, columnNumber }));
                    pids.push(pid);
                });
            }
        } else if (required) {
            errors.push(ValidationError({ description: `${fileName} is required.`, fileName }));
        }
    });

    await Promise.all(promises);

    return errors;
}

async function validateSettings (zip) {
    if (_verbose)
        log({ type: TYPE.INFO, description: 'Validating word/settings.xml...' });

    const errors = [];

    const fileName = zip.files.find(fileName => fileName === 'word/settings.xml');

    if (!fileName) {
        errors.push(ValidationError({ description: 'word/settings.xml is required.', fileName: 'word/settings.xml' }));
    } else {
        const xml = await zip.read(fileName);
        const document = XML.parse(XML.format(xml));

        let rsids = within(document).get('/w:settings/w:rsids');
        if (rsids) {
            const { lineNumber, columnNumber } = rsids;

            const rsidRoot = within(rsids).get('/w:rsidRoot');
            rsids = within(rsids).getAll('/w:rsid');

            if (!rsidRoot) {
                errors.push(ValidationError({ description: '<w:rsids/> requires a <w:rsidRoot/>.', fileName, lineNumber, columnNumber }));
            } else {
                const { lineNumber, columnNumber } = rsidRoot;
                if (!rsids.find(rsid => rsid.getAttribute('w:val') === rsidRoot.getAttribute('w:val')))
                    errors.push(ValidationError({ description: '<w:rsidRoot/> requires a corresponding <w:rsid/>.', fileName, lineNumber, columnNumber }));
            }

            const rsidValues = [];
            rsids.forEach(rsid => {
                const { lineNumber, columnNumber } = rsid;
                const rsidValue = rsid.getAttribute('w:val');
                if (!rsidValue) {
                    errors.push(ValidationError({ description: '<w:rsid/> requires a w:val attribute.', fileName, lineNumber, columnNumber }));
                } else {
                    if (rsidValues.includes(rsidValue))
                        errors.push(ValidationError({ description: `<w:rsid w:val="${rsidValue}"/> is not unique.`, fileName, lineNumber, columnNumber }));
                    rsidValues.push(rsidValue);
                }
            });
        }
    }

    return errors;
}

async function validateDocument (zip) {
    if (_verbose)
        log({ type: TYPE.INFO, description: 'Validating document...' });

    const errors = [];

    const fileName = zip.files
        .find(fileName => [ 'word/document.xml', 'word/document22.xml' ].includes(fileName));

    if (!fileName) {
        errors.push(ValidationError({ description: 'word/document.xml is required.', fileName: 'word/document.xml' }));
    } else {
        const xml = await zip.read(fileName);
        const document = XML.parse(XML.format(xml));
        const body = within(document).get('/w:document/w:body');

        const text = within(document).getAll('//(w:t|w:delText)');
        text.forEach(text => {
            const { lineNumber, columnNumber } = text;
            const space = text.getAttribute('xml:space');

            if (hasLeadingOrTrailingWhiteSpace(text.textContent)) {
                if (space !== 'preserve')
                    errors.push(ValidationError({ type: TYPE.WARNING, description: `<${text.nodeName}/> should preserve white space with xml:space="preserve".`, fileName, lineNumber, columnNumber }));
            } else {
                if (space === 'preserve')
                    errors.push(ValidationError({ type: TYPE.WARNING, description: `<${text.nodeName}/> has no white space to preserve with xml:space="preserve".`, fileName, lineNumber, columnNumber }));
            }
        });

        // TODO: check that all w:id attributes are unique
        // includes w:ins, w:del, w:comment, w:bookmark
        // const comments = within(body).getAll('//(w:ins|w:del|w:comment|w:bookmark)');

        // TODO: check that all w:ins and w:del nodes have authors, dates and rsids
        // as well as children unless they are within w:rPr
        // const trackedChanges = within(body).getAll('//(w:ins|w:del)');

        let commentsXml;
        const commentRangeStarts = within(body).getAll('//w:commentRangeStart');
        if (commentRangeStarts.length > 0) {
            const xml = await zip.read('word/comments.xml');
            commentsXml = XML.parse(XML.format(xml));
        }

        commentRangeStarts.forEach(commentRangeStart => {
            const { lineNumber, columnNumber } = commentRangeStart;
            const id = commentRangeStart.getAttribute('w:id');

            const commentRangeEnd = within(body).get(`//w:commentRangeEnd[@w:id="${id}"]`);
            if (!commentRangeEnd)
                errors.push(ValidationError({ description: `<w:commentRangeStart w:id="${id}"/> has no corresponding <w:commentRangeEnd w:id="${id}"/>.`, fileName, lineNumber, columnNumber }));

            const commentRangeReference = within(body).get(`//w:commentReference[@w:id="${id}"]`);
            if (!commentRangeReference)
                errors.push(ValidationError({ description: `<w:commentRangeStart w:id="${id}"/> has no corresponding <w:commentRangeReference w:id="${id}"/>.`, fileName, lineNumber, columnNumber }));

            const comment = within(commentsXml).get(`//w:comment[@w:id="${id}"]`);
            if (!comment)
                errors.push(ValidationError({ description: `<w:comment w:id="${id}"/> has been referenced but is missing.`, fileName, lineNumber, columnNumber }));
        });
    }

    return errors;
}

async function validateRelationships (zip) {
    if (_verbose)
        log({ type: TYPE.INFO, description: 'Validating relationships...' });

    const errors = [];

    const fileName = zip.files.find(fileName => fileName === '_rels/.rels');

    if (!fileName) {
        errors.push(ValidationError({ description: '_rels/.rels is required.', fileName: '_rels/.rels' }));
    } else {
        const xml = await zip.read(fileName);
        const document = XML.parse(XML.format(xml));

        const relationships = within(document).getAll('/Relationships/Relationship');

        const relIds = [];
        relationships.forEach(relationship => {
            const { lineNumber, columnNumber } = relationship;
            const Id = relationship.getAttribute('Id');
            if (!Id.match(/^rId[\d]+$/))
                errors.push(ValidationError({ description: `<Relationship Id="${Id}"/> is invalid.`, fileName, lineNumber, columnNumber }));
            if (relIds.includes(Id))
                errors.push(ValidationError({ description: `<Relationship Id="${Id}"/> is not unique.`, fileName, lineNumber, columnNumber }));
            relIds.push(Id);
        });
    }

    return errors;
}

async function validateWordRelationships (zip) {
    if (_verbose)
        log({ type: TYPE.INFO, description: 'Validating document relationships...' });

    const errors = [];

    const fileName = zip.files
        .find(fileName => [ 'word/_rels/document.xml.rels', 'word/_rels/document22.xml.rels' ].includes(fileName));

    if (!fileName) {
        errors.push(ValidationError({ description: 'word/_rels/document.xml.rels is required.', fileName: 'word/_rels/document.xml.rels' }));
    } else {
        const xml = await zip.read(fileName);
        const document = XML.parse(XML.format(xml));

        const relationships = within(document).getAll('/Relationships/Relationship');

        const relIds = [];
        relationships.forEach(relationship => {
            const { lineNumber, columnNumber } = relationship;
            const Id = relationship.getAttribute('Id');
            if (relIds.includes(Id))
                errors.push(ValidationError({ description: `<Relationship Id="${Id}"/> is not unique.`, fileName, lineNumber, columnNumber }));
            relIds.push(Id);
        });
    }

    return errors;
}

async function validate (file, { verbose } = {}) {
    _verbose = verbose;

    if (_verbose)
        log({ type: TYPE.INFO, description: 'Unzipping file...' });

    const zip = await Zip.unzip(file);

    const errors = await Promise.all([
        validateXml(zip),
        validateContentTypes(zip),
        validateDocProps(zip),
        validateSettings(zip),
        validateDocument(zip),
        validateRelationships(zip),
        validateWordRelationships(zip),
    ]);

    return errors.reduce((errors, error) => errors.concat(error), []);
}

function log ({ type, description, fileName, lineNumber, columnNumber }) {
    let severity;
    let style;
    switch (type) {
        case TYPE.INFO:
            severity = 'Information';
            break;
        case TYPE.WARN:
            severity = 'Warning';
            style = STYLE.YELLOW;
            break;
        default:
            severity = 'Error';
            style = STYLE.RED;
            break;
    }

    let location = '';
    if (!isNil(fileName)) {
        location += ` at ${fileName}`;
        if (!isNil(lineNumber)) {
            location += `:${lineNumber}`;
            if (!isNil(columnNumber))
                location += `:${columnNumber}`;
        }
    }

    if (type !== TYPE.INFO)
        print(`${severity}${location}`, { type, style });

    print(description, { type, style });
}

module.exports = {
    validate,
    log,
};