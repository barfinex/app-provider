import { Inspector } from "@barfinex/types";
import { Column, Entity, ObjectId, ObjectIdColumn, UpdateDateColumn, CreateDateColumn } from "typeorm";

@Entity()
export class InspectorEntity {

    @ObjectIdColumn()
    id: ObjectId;

    @Column()
    name: string;

    @Column()
    options: Inspector;

    @Column('timestampz')
    @CreateDateColumn()
    created!: Date;

    @Column('timestamptz')
    @UpdateDateColumn()
    updated!: Date;
}