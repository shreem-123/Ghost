const {
    PostsImporter,
    NewslettersImporter,
    UsersImporter,
    PostsAuthorsImporter,
    TagsImporter,
    PostsTagsImporter,
    ProductsImporter,
    MembersImporter,
    BenefitsImporter,
    ProductsBenefitsImporter,
    MembersProductsImporter,
    PostsProductsImporter,
    MembersNewslettersImporter,
    MembersCreatedEventsImporter,
    MembersLoginEventsImporter,
    MembersStatusEventsImporter,
    StripeProductsImporter,
    StripePricesImporter,
    SubscriptionsImporter,
    MembersStripeCustomersImporter,
    MembersStripeCustomersSubscriptionsImporter,
    MembersPaidSubscriptionEventsImporter,
    MembersSubscriptionCreatedEventsImporter,
    MembersSubscribeEventsImporter
} = require('./tables');
const {faker} = require('@faker-js/faker');

/**
 * @typedef {Object} DataGeneratorOptions
 * @property {boolean} useBaseData
 * @property {import('knex/types').Knex} knex
 * @property {Object} schema
 * @property {Object} logger
 * @property {Object} modelQuantities
 */

const defaultQuantities = {
    members: () => faker.datatype.number({
        min: 7000,
        max: 8000
    }),
    membersLoginEvents: 100,
    posts: () => faker.datatype.number({
        min: 80,
        max: 120
    })
};

class DataGenerator {
    /**
     *
     * @param {DataGeneratorOptions} options
     */
    constructor({
        useBaseData = false,
        knex,
        schema,
        logger,
        modelQuantities = {}
    }) {
        this.useBaseData = useBaseData;
        this.knex = knex;
        this.schema = schema;
        this.logger = logger;
        this.modelQuantities = Object.assign({}, defaultQuantities, modelQuantities);
    }

    async importData() {
        const transaction = await this.knex.transaction();

        const usersImporter = new UsersImporter(transaction);
        const users = await usersImporter.import({amount: 8});

        let newsletters;
        let posts;
        let tags;
        let products;
        let stripeProducts;
        let stripePrices;

        // Use an existant set of data for a more realisitic looking site
        if (this.useBaseData) {
            // Must have at least 2 in base data set
            newsletters = await transaction.select('id').from('newsletters');

            const postsImporter = new PostsImporter(transaction, {
                newsletters
            });
            posts = await transaction.select('id').from('posts');
            postsImporter.addNewsletters({posts});
            posts = await transaction.select('id', 'newsletter_id').from('posts');

            tags = await transaction.select('id').from('tags');

            products = await transaction.select('id', 'name', 'monthly_price', 'yearly_price').from('products');
            stripeProducts = await transaction.select('id', 'product_id', 'stripe_product_id').from('stripe_products');
            stripePrices = await transaction.select('id', 'stripe_price_id', 'interval', 'stripe_product_id', 'currency', 'amount', 'nickname');
        } else {
            const newslettersImporter = new NewslettersImporter(transaction);
            // First newsletter is free, second is paid
            newsletters = await newslettersImporter.import({amount: 2});

            const postsImporter = new PostsImporter(transaction, {
                newsletters
            });
            posts = await postsImporter.import({
                amount: this.modelQuantities.posts,
                rows: ['newsletter_id']
            });

            const tagsImporter = new TagsImporter(transaction, {
                users
            });
            tags = await tagsImporter.import({amount: faker.datatype.number({
                min: 16,
                max: 24
            })});

            const productsImporter = new ProductsImporter(transaction);
            products = await productsImporter.import({amount: 4, rows: ['name', 'monthly_price', 'yearly_price']});

            const stripeProductsImporter = new StripeProductsImporter(transaction);
            stripeProducts = await stripeProductsImporter.importForEach(products, {
                amount: 1,
                rows: ['product_id', 'stripe_product_id']
            });

            const stripePricesImporter = new StripePricesImporter(transaction, {products});
            stripePrices = await stripePricesImporter.importForEach(stripeProducts, {
                amount: 2,
                rows: ['stripe_price_id', 'interval', 'stripe_product_id', 'currency', 'amount', 'nickname']
            });

            await productsImporter.addStripePrices({
                products,
                stripeProducts,
                stripePrices
            });

            const benefitsImporter = new BenefitsImporter(transaction);
            const benefits = await benefitsImporter.import({amount: 5});

            const productsBenefitsImporter = new ProductsBenefitsImporter(transaction, {benefits});
            // Up to 5 benefits for each product
            await productsBenefitsImporter.importForEach(products, {amount: 5});
        }

        const postsTagsImporter = new PostsTagsImporter(transaction, {
            tags
        });
        await postsTagsImporter.importForEach(posts, {
            amount: () => faker.datatype.number({
                min: 0,
                max: 3
            })
        });

        const membersImporter = new MembersImporter(transaction);
        const members = await membersImporter.import({amount: this.modelQuantities.members, rows: ['status', 'created_at', 'name', 'email']});

        const postsAuthorsImporter = new PostsAuthorsImporter(transaction, {
            users
        });
        await postsAuthorsImporter.importForEach(posts, {amount: 1});

        // TODO: Use subscriptions to generate members_products table?
        const membersProductsImporter = new MembersProductsImporter(transaction, {products: products.slice(1)});
        const membersProducts = await membersProductsImporter.importForEach(members.filter(member => member.status !== 'free'), {
            amount: 1,
            rows: ['product_id', 'member_id']
        });
        const membersFreeProductsImporter = new MembersProductsImporter(transaction, {products: [products[0]]});
        await membersFreeProductsImporter.importForEach(members.filter(member => member.status === 'free'), {
            amount: 1,
            rows: ['product_id', 'member_id']
        });

        const postsProductsImporter = new PostsProductsImporter(transaction, {products: products.slice(1)});
        // Paid newsletters
        await postsProductsImporter.importForEach(posts.filter(post => newsletters.findIndex(newsletter => newsletter.id === post.newsletter_id) === 1), {
            // Each post is available on all 3 premium products
            amount: 3
        });

        const membersCreatedEventsImporter = new MembersCreatedEventsImporter(transaction);
        await membersCreatedEventsImporter.importForEach(members, {amount: 1});

        const membersLoginEventsImporter = new MembersLoginEventsImporter(transaction);
        // Will create roughly 1 login event for every 3 days, up to a maximum of 100.
        await membersLoginEventsImporter.importForEach(members, {amount: this.modelQuantities.membersLoginEvents});

        const membersStatusEventsImporter = new MembersStatusEventsImporter(transaction);
        // Up to 2 events per member - 1 from null -> free, 1 from free -> {paid, comped}
        await membersStatusEventsImporter.importForEach(members, {amount: 2});

        const subscriptionsImporter = new SubscriptionsImporter(transaction, {members, stripeProducts, stripePrices});
        const subscriptions = await subscriptionsImporter.importForEach(membersProducts, {
            amount: 1,
            rows: ['cadence', 'tier_id', 'expires_at', 'created_at', 'member_id', 'currency']
        });

        const membersStripeCustomersImporter = new MembersStripeCustomersImporter(transaction);
        const membersStripeCustomers = await membersStripeCustomersImporter.importForEach(members, {
            amount: 1,
            rows: ['customer_id', 'member_id']
        });

        const membersStripeCustomersSubscriptionsImporter = new MembersStripeCustomersSubscriptionsImporter(transaction, {
            membersStripeCustomers,
            products,
            stripeProducts,
            stripePrices
        });
        const membersStripeCustomersSubscriptions = await membersStripeCustomersSubscriptionsImporter.importForEach(subscriptions, {
            amount: 1,
            rows: ['mrr', 'plan_id', 'subscription_id']
        });

        const membersSubscribeEventsImporter = new MembersSubscribeEventsImporter(transaction, {newsletters, subscriptions});
        const membersSubscribeEvents = await membersSubscribeEventsImporter.importForEach(members, {
            amount: 2,
            rows: ['member_id', 'newsletter_id']
        });

        const membersNewslettersImporter = new MembersNewslettersImporter(transaction);
        await membersNewslettersImporter.importForEach(membersSubscribeEvents, {amount: 1});

        const membersPaidSubscriptionEventsImporter = new MembersPaidSubscriptionEventsImporter(transaction, {
            membersStripeCustomersSubscriptions
        });
        await membersPaidSubscriptionEventsImporter.importForEach(subscriptions, {amount: 1});

        const membersSubscriptionCreatedEventsImporter = new MembersSubscriptionCreatedEventsImporter(transaction, {subscriptions});
        await membersSubscriptionCreatedEventsImporter.importForEach(membersStripeCustomersSubscriptions, {amount: 1});

        // TODO: Emails! (relies on posts & newsletters)

        // TODO: Email clicks - redirect, members_click_events (relies on emails)

        // TODO: Feedback - members_feedback (relies on members and posts)

        await transaction.commit();
    }
}

module.exports = DataGenerator;
