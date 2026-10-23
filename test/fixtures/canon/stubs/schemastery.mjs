/** Schemastery as Canon's Config uses it: types, defaults and live fields, recorded. */
const field = (type) => {
    const schema = { type, value: undefined, live: false };
    schema.default = (value) => Object.assign(schema, { value });
    schema.volatile = () => Object.assign(schema, { live: true });
    return schema;
};
const z = {
    object: (shape) => ({ type: 'object', shape }),
    boolean: () => field('boolean'),
    string: () => field('string'),
    number: () => field('number'),
    any: () => field('any'),
};
export default z;
